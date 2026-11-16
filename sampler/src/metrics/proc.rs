//! Per-pane resource attribution.
//!
//! This is the part no generic system monitor can do: herdr knows which shell
//! belongs to which pane, so we can roll a whole process tree up to "tri ›
//! claude" instead of leaving you to work out what PID 48213 is.
//!
//! We only ever read the process *name*. herdr's `pane.process_info` also
//! returns full argv, and on the machine this was written on that argv included
//! a live API key in plain text. A dashboard that renders argv puts secrets on
//! screen and into every screenshot of it, so this module never reads argv at
//! all — not as a display choice, but so the data is never in the process.
//!
//! CPU is per-PID delta accounting, not a per-tree cumulative diff. A tree's
//! total CPU time is not monotonic — when a child exits, the tree total drops —
//! so diffing tree totals would underreport busy panes exactly when they are
//! churning subprocesses, which is what agents do constantly.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// What one pane's process tree is costing.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PaneUsage {
    /// Busy cores as a fraction: 2.14 means 214%, i.e. just over two cores.
    pub cpu: f32,
    /// Summed resident bytes across the tree. Shared pages are counted once per
    /// process, which is the same approximation `top` makes.
    pub rss: u64,
    /// How many processes the tree contained.
    pub processes: usize,
    /// Name of the heaviest process in the tree, for a human-readable label.
    pub busiest: Option<String>,
}

/// Depth and breadth guards. An agent's tree is realistically tens of
/// processes; these only exist so a pathological or cyclic tree cannot turn one
/// tick into an unbounded walk.
const MAX_DEPTH: u32 = 12;
const MAX_PROCESSES_PER_PANE: usize = 512;

pub struct ProcCollector {
    /// Cumulative CPU nanoseconds per PID, as of the previous tick.
    previous: HashMap<i32, u64>,
    /// Rebuilt each tick, then swapped in, so pruning dead PIDs is free.
    current: HashMap<i32, u64>,
    last_sampled: Option<Instant>,
    children: Vec<i32>,
    stack: Vec<(i32, u32)>,
}

impl ProcCollector {
    pub fn new() -> Self {
        Self {
            previous: HashMap::new(),
            current: HashMap::new(),
            last_sampled: None,
            children: Vec::new(),
            stack: Vec::new(),
        }
    }

    /// Samples every pane's tree in one pass.
    ///
    /// `panes` maps a pane id to the pid of the shell herdr started in it. The
    /// first call establishes the CPU baseline and reports zero CPU, which is
    /// correct rather than a placeholder: we genuinely do not know yet.
    pub fn sample<'a, I>(&mut self, panes: I) -> Vec<(String, PaneUsage)>
    where
        I: IntoIterator<Item = (&'a str, i32)>,
    {
        let now = Instant::now();
        let elapsed = self
            .last_sampled
            .map(|then| now.duration_since(then))
            .unwrap_or(Duration::ZERO);
        let elapsed_ns = elapsed.as_nanos() as f64;

        self.current.clear();
        let mut out = Vec::new();

        for (pane_id, shell_pid) in panes {
            if shell_pid <= 0 {
                continue;
            }
            let mut usage = PaneUsage::default();
            let mut busiest_cpu = 0u64;
            let mut busiest_pid: Option<i32> = None;
            let mut delta_ns_total = 0u64;

            self.stack.clear();
            self.stack.push((shell_pid, 0));

            while let Some((pid, depth)) = self.stack.pop() {
                if usage.processes >= MAX_PROCESSES_PER_PANE {
                    break;
                }
                // A pid reachable from two panes (or twice in a cycle) must not
                // be counted twice, and must not be re-walked.
                if self.current.contains_key(&pid) {
                    continue;
                }

                if let Some(task) = task_info(pid) {
                    let cpu_ns = super::mach_ticks_to_ns(task.pti_total_user.saturating_add(task.pti_total_system));
                    self.current.insert(pid, cpu_ns);

                    let delta = self
                        .previous
                        .get(&pid)
                        .map(|before| cpu_ns.saturating_sub(*before))
                        // A process first seen this tick has no baseline. Its
                        // lifetime CPU is not this interval's CPU, so count zero
                        // rather than attributing its whole history to one tick.
                        .unwrap_or(0);
                    delta_ns_total = delta_ns_total.saturating_add(delta);

                    usage.rss = usage.rss.saturating_add(task.pti_resident_size);
                    usage.processes += 1;

                    // Remember the winner and name it once the walk is done.
                    // `proc_name` is a syscall, and on an idle tree every delta
                    // is zero — so naming each candidate as it appeared meant a
                    // call per process to produce a single answer, and left
                    // `busiest` holding whichever zero-delta process happened to
                    // be visited last rather than a meaningful one.
                    if busiest_pid.is_none() || delta > busiest_cpu {
                        busiest_cpu = delta;
                        busiest_pid = Some(pid);
                    }
                } else {
                    // Exited between listing and inspection. Mark it seen so a
                    // cycle cannot revisit it.
                    self.current.insert(pid, 0);
                }

                if depth < MAX_DEPTH {
                    list_children(pid, &mut self.children);
                    for child in self.children.drain(..) {
                        self.stack.push((child, depth + 1));
                    }
                }
            }

            usage.busiest = busiest_pid.and_then(process_name);
            usage.cpu = if elapsed_ns > 0.0 {
                (delta_ns_total as f64 / elapsed_ns) as f32
            } else {
                0.0
            };
            out.push((pane_id.to_string(), usage));
        }

        std::mem::swap(&mut self.previous, &mut self.current);
        self.last_sampled = Some(now);
        out
    }
}

impl Default for ProcCollector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
fn task_info(pid: i32) -> Option<libc::proc_taskinfo> {
    let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
    // SAFETY: proc_pidinfo writes at most `size` bytes of the flavor-matched
    // struct. A short or negative return means it wrote nothing usable.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr() as *mut libc::c_void,
            size,
        )
    };
    // SAFETY: a full-size write means every field was initialised.
    (written == size).then(|| unsafe { info.assume_init() })
}

#[cfg(target_os = "macos")]
fn list_children(pid: i32, out: &mut Vec<i32>) {
    // `proc_listchildpids` takes a buffer size in BYTES but returns a COUNT OF
    // PIDS, unlike most of the proc_list* family which return bytes written.
    // Dividing the return value by size_of::<i32>() silently floors small trees
    // to zero, which looks exactly like "this pane has no child processes".
    //
    // Its null-buffer probe is also not a required-size query — it answers with
    // a system-wide scratch size (598 on a machine with one child here) — so
    // there is no point calling it. Allocate once and grow only if full.
    out.clear();
    out.resize(64, 0);
    loop {
        // SAFETY: the buffer holds `out.len()` i32s and we pass its byte length.
        let written = unsafe {
            libc::proc_listchildpids(
                pid,
                out.as_mut_ptr() as *mut libc::c_void,
                (out.len() * std::mem::size_of::<i32>()) as i32,
            )
        };
        if written <= 0 {
            out.clear();
            return;
        }
        let written = written as usize;
        // A full buffer may mean the list was truncated, so retry with more room.
        if written == out.len() && out.len() < MAX_PROCESSES_PER_PANE {
            out.resize((out.len() * 2).min(MAX_PROCESSES_PER_PANE), 0);
            continue;
        }
        out.truncate(written.min(out.len()));
        break;
    }
    out.retain(|&pid| pid > 0);
}

#[cfg(target_os = "macos")]
fn process_name(pid: i32) -> Option<String> {
    // Deliberately proc_name and not argv: see the module comment.
    let mut buffer = [0u8; 64];
    // SAFETY: proc_name writes at most `buffer.len()` bytes, NUL-terminated.
    let written = unsafe {
        libc::proc_name(
            pid,
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as u32,
        )
    };
    if written <= 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|&b| b == 0)
        .unwrap_or(written as usize);
    Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
}

#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy)]
struct TaskInfo {
    pti_total_user: u64,
    pti_total_system: u64,
    pti_resident_size: u64,
}

#[cfg(not(target_os = "macos"))]
fn task_info(pid: i32) -> Option<TaskInfo> {
    // /proc/<pid>/stat field 14 (utime) and 15 (stime) are in clock ticks; 24
    // (rss) is in pages. Fields are 1-indexed from the manpage, and comm can
    // contain spaces, so parse after the closing paren.
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &raw[raw.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // Field 3 (state) is the first in `rest`, so field N is index N - 3.
    let get = |one_indexed: usize| -> u64 {
        one_indexed
            .checked_sub(3)
            .and_then(|index| fields.get(index))
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    };
    let hz = 100u64;
    let page = 4096u64;
    Some(TaskInfo {
        pti_total_user: get(14) * 1_000_000_000 / hz,
        pti_total_system: get(15) * 1_000_000_000 / hz,
        pti_resident_size: get(24) * page,
    })
}

#[cfg(not(target_os = "macos"))]
fn list_children(pid: i32, out: &mut Vec<i32>) {
    out.clear();
    // `children` is per-thread, and it lists only what *that* thread forked.
    // Reading the main task alone loses every subtree spawned from a worker
    // thread, which is the normal case for the runtimes panes actually run —
    // node, python, any agent that shells out off its main thread. The symptom
    // is a pane whose usage collapses to just its shell and looks plausible,
    // the same failure the macOS branch above guards against.
    //
    // A pid has exactly one parent thread, so the union across tasks needs no
    // deduplication. Threads come and go while this walks; per-entry errors are
    // skipped rather than aborting the walk.
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return;
    };
    for task in tasks.flatten() {
        let remaining = MAX_PROCESSES_PER_PANE.saturating_sub(out.len());
        if remaining == 0 {
            break;
        }
        let Ok(raw) = std::fs::read_to_string(task.path().join("children")) else {
            continue;
        };
        out.extend(
            raw.split_whitespace()
                .filter_map(|v| v.parse::<i32>().ok())
                .filter(|&p| p > 0)
                .take(remaining),
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn process_name(pid: i32) -> Option<String> {
    // comm, never cmdline: see the module comment.
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sample_reports_zero_cpu_but_real_memory() {
        let mut c = ProcCollector::new();
        let me = std::process::id() as i32;
        let out = c.sample([("w1:p1", me)]);
        assert_eq!(out.len(), 1);
        let usage = &out[0].1;
        // No baseline yet, so lifetime CPU must not be reported as this tick's.
        assert_eq!(usage.cpu, 0.0);
        assert!(
            usage.processes >= 1,
            "should have found at least this process"
        );
        assert!(usage.rss > 0, "this process is resident");
    }

    #[test]
    fn second_sample_measures_work_done_between_ticks() {
        let mut c = ProcCollector::new();
        let me = std::process::id() as i32;
        c.sample([("w1:p1", me)]);
        // Spin for a fixed time, not a fixed count: Linux counts CPU in 10 ms ticks, and an
        // optimised loop can finish inside one.
        let until = Instant::now() + Duration::from_millis(200);
        let mut acc = 0u64;
        while Instant::now() < until {
            acc = std::hint::black_box(acc.wrapping_add(2654435761));
        }
        let out = c.sample([("w1:p1", me)]);
        let usage = &out[0].1;
        assert!(
            usage.cpu > 0.0,
            "busy loop should register CPU, got {}",
            usage.cpu
        );
        // A single-threaded burn cannot exceed one core by much.
        assert!(usage.cpu < 8.0, "implausible cpu {}", usage.cpu);
    }

    #[test]
    fn dead_pids_are_pruned_from_the_baseline() {
        let mut c = ProcCollector::new();
        let me = std::process::id() as i32;
        c.sample([("w1:p1", me)]);
        assert!(c.previous.contains_key(&me));
        // Sampling a pane that no longer references this pid must drop it,
        // otherwise the map grows for the life of the daemon.
        c.sample([("w1:p1", 999_999_999)]);
        assert!(!c.previous.contains_key(&me));
    }

    #[test]
    fn walks_real_child_processes() {
        // Regression: proc_listchildpids returns a pid COUNT, not a byte count.
        // Treating it as bytes floored every small tree to zero children, so a
        // pane's usage collapsed to just its shell and looked plausible.
        //
        // Spawned from a worker thread on purpose. Linux's `children` file is
        // per-thread, so a walk that reads only the main task misses this and
        // reports an empty tree — the same collapse, different cause. The test
        // harness happens to run tests off the main thread already, but that is
        // an implementation detail of the harness and not something to rely on.
        let mut child = std::thread::spawn(|| {
            std::process::Command::new("/bin/sh")
                .args(["-c", "sleep 30"])
                .spawn()
                .expect("spawn child")
        })
        .join()
        .expect("spawner thread");

        let mut kids = Vec::new();
        list_children(std::process::id() as i32, &mut kids);
        assert!(
            kids.contains(&(child.id() as i32)),
            "expected to find child {} in {kids:?}",
            child.id()
        );

        // And the tree walk must actually reach it.
        let mut c = ProcCollector::new();
        let out = c.sample([("w1:p1", std::process::id() as i32)]);
        assert!(
            out[0].1.processes >= 2,
            "tree should contain this process and its child, got {}",
            out[0].1.processes
        );

        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn list_children_is_empty_for_a_leaf() {
        let mut kids = Vec::new();
        list_children(999_999_999, &mut kids);
        assert!(kids.is_empty());
    }

    #[test]
    fn nonexistent_pid_yields_empty_usage() {
        let mut c = ProcCollector::new();
        let out = c.sample([("w1:p1", 999_999_999)]);
        assert_eq!(out[0].1.processes, 0);
        assert_eq!(out[0].1.rss, 0);
        assert_eq!(out[0].1.busiest, None);
    }

    #[test]
    fn nonpositive_pids_are_skipped_entirely() {
        let mut c = ProcCollector::new();
        // pid 0 and -1 are wildcards to kill(2); never walk them.
        let out = c.sample([("w1:p1", 0), ("w1:p2", -1)]);
        assert!(out.is_empty());
    }

    #[test]
    fn a_pid_shared_between_panes_is_counted_once() {
        let mut c = ProcCollector::new();
        let me = std::process::id() as i32;
        let out = c.sample([("w1:p1", me), ("w1:p2", me)]);
        // The second pane sees the pid already claimed, so it must not
        // double-count the same resident bytes into the machine's total.
        assert!(out[0].1.processes >= 1);
        assert_eq!(out[1].1.processes, 0);
    }
}
