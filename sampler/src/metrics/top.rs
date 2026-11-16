//! The machine's busiest processes, for the dashboard.
//!
//! Only processes this user may inspect are listed (another user's, root's
//! daemons, the kernel are not readable without privileges), which is also
//! the set the person can act on. Names only, never argv: see `proc.rs`.

use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub struct TopProcess {
    pub pid: i32,
    pub name: String,
    /// Busy cores as a fraction (2.0 = two cores).
    pub cpu: f32,
    pub rss: u64,
}

pub struct TopCollector {
    previous: HashMap<i32, u64>,
    last: Option<Instant>,
    pids: Vec<i32>,
    /// `HERDR_STATS_TOP_UNDER`: list only programs whose executable is under this folder.
    /// The README's pictures use it, so they show the demo's programs and none of the Mac's.
    under: Option<String>,
}

impl TopCollector {
    pub fn new() -> Self {
        let under = std::env::var("HERDR_STATS_TOP_UNDER").ok().filter(|p| !p.is_empty());
        Self { previous: HashMap::new(), last: None, pids: Vec::new(), under }
    }

    /// The `limit` busiest, by CPU then memory. The first call has no CPU baseline.
    pub fn sample(&mut self, limit: usize) -> Vec<TopProcess> {
        let now = Instant::now();
        let elapsed_ns = self.last.map(|t| now.duration_since(t).as_nanos() as f64).unwrap_or(0.0);
        list_all(&mut self.pids);
        let mut current = HashMap::with_capacity(self.pids.len());
        let mut rows: Vec<(i32, f32, u64)> = Vec::with_capacity(self.pids.len());
        for &pid in &self.pids {
            if let Some(under) = &self.under {
                if !exe_path(pid).is_some_and(|p| p.starts_with(under.as_str())) {
                    continue;
                }
            }
            let Some((cpu_ns, rss)) = usage(pid) else { continue };
            current.insert(pid, cpu_ns);
            let delta = self.previous.get(&pid).map(|b| cpu_ns.saturating_sub(*b)).unwrap_or(0);
            let cpu = if elapsed_ns > 0.0 { (delta as f64 / elapsed_ns) as f32 } else { 0.0 };
            rows.push((pid, cpu, rss));
        }
        self.previous = current;
        self.last = Some(now);
        rows.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.2.cmp(&a.2)));
        rows.into_iter()
            .take(limit)
            .filter_map(|(pid, cpu, rss)| Some(TopProcess { pid, name: name(pid)?, cpu, rss }))
            .collect()
    }
}

impl Default for TopCollector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
fn list_all(out: &mut Vec<i32>) {
    out.clear();
    out.resize(4096, 0);
    loop {
        // SAFETY: the buffer holds out.len() i32s and we pass its byte size. The
        // return value is a count of pids (like proc_listchildpids).
        let n = unsafe {
            libc::proc_listallpids(out.as_mut_ptr() as *mut libc::c_void, (out.len() * 4) as i32)
        };
        if n <= 0 {
            out.clear();
            return;
        }
        let n = n as usize;
        if n >= out.len() && out.len() < 65536 {
            out.resize(out.len() * 2, 0);
            continue;
        }
        out.truncate(n.min(out.len()));
        out.retain(|&p| p > 0);
        return;
    }
}

#[cfg(target_os = "macos")]
fn exe_path(pid: i32) -> Option<String> {
    let mut buf = [0u8; 4096];
    // SAFETY: proc_pidpath writes at most buf.len() bytes and returns the length.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn exe_path(pid: i32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn usage(pid: i32) -> Option<(u64, u64)> {
    let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
    // SAFETY: a full-size write initialises every field.
    let written = unsafe {
        libc::proc_pidinfo(pid, libc::PROC_PIDTASKINFO, 0, info.as_mut_ptr() as *mut libc::c_void, size)
    };
    if written != size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    Some((super::mach_ticks_to_ns(info.pti_total_user.saturating_add(info.pti_total_system)), info.pti_resident_size))
}

#[cfg(target_os = "macos")]
fn name(pid: i32) -> Option<String> {
    let mut buffer = [0u8; 64];
    // SAFETY: proc_name writes at most buffer.len() bytes, NUL-terminated.
    let n = unsafe { libc::proc_name(pid, buffer.as_mut_ptr() as *mut libc::c_void, buffer.len() as u32) };
    if n <= 0 {
        return None;
    }
    let end = buffer.iter().position(|&b| b == 0).unwrap_or(n as usize);
    Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn list_all(out: &mut Vec<i32>) {
    out.clear();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        out.extend(entries.flatten().filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok()));
    }
}

#[cfg(not(target_os = "macos"))]
fn usage(pid: i32) -> Option<(u64, u64)> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &raw[raw.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    let get = |i: usize| f.get(i - 3).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    Some(((get(14) + get(15)) * 10_000_000, get(24) * 4096))
}

#[cfg(not(target_os = "macos"))]
fn name(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_listed_and_named() {
        let mut t = TopCollector::new();
        let rows = t.sample(10_000);
        let me = std::process::id() as i32;
        let found = rows.iter().find(|r| r.pid == me).expect("this process is readable");
        assert!(!found.name.is_empty());
        assert!(found.rss > 0);
    }

    #[test]
    fn the_limit_is_respected() {
        let mut t = TopCollector::new();
        assert!(t.sample(3).len() <= 3);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod cpu_time_tests {
    use super::usage;
    use std::time::{Duration, Instant};

    #[test]
    fn a_process_busy_for_200_ms_used_about_200_ms() {
        let me = std::process::id() as i32;
        let (before, _) = usage(me).expect("own task info");
        let start = Instant::now();
        let mut x = 0u64;
        while start.elapsed() < Duration::from_millis(200) {
            x = std::hint::black_box(x.wrapping_add(1));
        }
        let (after, _) = usage(me).expect("own task info");
        let ms = (after - before) / 1_000_000;
        // In Mach ticks unconverted, Apple Silicon would report about 5 ms here.
        assert!((150..=1000).contains(&ms), "measured {ms} ms of CPU for 200 ms of spinning");
    }

    #[test]
    fn this_process_has_an_executable_path() {
        let path = super::exe_path(std::process::id() as i32).expect("own path");
        assert!(path.starts_with('/'), "{path}");
    }
}
