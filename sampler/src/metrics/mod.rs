//! Metric collection.
//!
//! Every collector holds whatever state it needs to turn kernel counters into
//! rates, and writes into caller-owned buffers where it can, so the steady
//! state does no allocation worth measuring.

pub mod cpu;
pub mod disk;
pub mod fan;
pub mod gpu;
pub mod mem;
pub mod net;
pub mod proc;
#[cfg(target_os = "macos")]
pub mod smc;
pub mod temp;
pub mod top;

use std::time::Instant;

pub use cpu::{CpuCollector, CpuSample};
pub use disk::{DiskCollector, DiskSample};
pub use fan::{FanCollector, FanSample};
pub use gpu::GpuCollector;
pub use net::NetCollector;
pub use top::TopCollector;
pub use mem::{MemCollector, MemSample};
pub use proc::ProcCollector;
pub use temp::{TempCollector, TempSample};

/// One tick's view of the machine.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    pub cpu: CpuSample,
    pub mem: MemSample,
    pub disk: DiskSample,
    pub temp: TempSample,
    pub fan: FanSample,
}

/// Reads a scalar sysctl by name.
///
/// Handles both the 4- and 8-byte cases, since `hw.memsize` is a u64 while
/// `hw.perflevel0.logicalcpu` is a u32, and getting that wrong silently yields
/// garbage rather than an error.
#[cfg(target_os = "macos")]
pub fn sysctl_u64(name: &str) -> Option<u64> {
    let cname = std::ffi::CString::new(name).ok()?;
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: sysctlbyname writes at most `size` bytes into `value` and updates
    // `size` with what it actually wrote.
    let status = unsafe {
        libc::sysctlbyname(
            cname.as_ptr(),
            &mut value as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return None;
    }
    match size {
        8 => Some(value),
        4 => Some(value as u32 as u64),
        _ => None,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn sysctl_u64(_name: &str) -> Option<u64> {
    None
}

/// Fixed-capacity history for sparklines.
///
/// The dashboard shows history from the moment the daemon started, not from the
/// moment the popup opened, which is the whole reason the daemon owns this
/// rather than the UI. A fixed ring means that costs a known, small number of
/// bytes forever.
#[derive(Debug, Clone)]
pub struct History {
    values: Box<[f32]>,
    head: usize,
    len: usize,
}

impl History {
    pub fn new(capacity: usize) -> Self {
        Self {
            values: vec![0.0; capacity.max(1)].into_boxed_slice(),
            head: 0,
            len: 0,
        }
    }

    pub fn push(&mut self, value: f32) {
        self.values[self.head] = value;
        self.head = (self.head + 1) % self.values.len();
        self.len = (self.len + 1).min(self.values.len());
    }

    /// Oldest to newest.
    pub fn iter(&self) -> impl Iterator<Item = f32> + '_ {
        let cap = self.values.len();
        // When not yet full, the oldest sample is at 0; once full, it is at head.
        let start = if self.len < cap { 0 } else { self.head };
        (0..self.len).map(move |i| self.values[(start + i) % cap])
    }
}

/// Tracks when a periodic job is next due.
///
/// The daemon runs several cadences off one loop — CPU and memory every tick,
/// disk and temperatures more slowly, per-pane work only when someone is
/// watching.
#[derive(Debug)]
pub struct Cadence {
    interval: std::time::Duration,
    last: Option<Instant>,
}

impl Cadence {
    pub fn new(interval: std::time::Duration) -> Self {
        Self {
            interval,
            last: None,
        }
    }

    /// True when the interval has elapsed, and records the firing.
    pub fn due(&mut self, now: Instant) -> bool {
        match self.last {
            Some(last) if now.duration_since(last) < self.interval => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn history_reports_values_oldest_first_before_wrapping() {
        let mut h = History::new(4);
        h.push(1.0);
        h.push(2.0);
        assert_eq!(h.iter().collect::<Vec<_>>(), vec![1.0, 2.0]);
    }

    #[test]
    fn history_keeps_order_across_the_wrap() {
        let mut h = History::new(3);
        for v in [1.0, 2.0, 3.0, 4.0, 5.0] {
            h.push(v);
        }
        // Oldest surviving sample first, newest last.
        assert_eq!(h.iter().collect::<Vec<_>>(), vec![3.0, 4.0, 5.0]);
        assert_eq!(h.iter().count(), 3);
    }

    #[test]
    fn zero_capacity_history_still_works() {
        let mut h = History::new(0);
        h.push(1.0);
        assert_eq!(h.iter().count(), 1);
    }

    #[test]
    fn cadence_fires_immediately_then_waits() {
        let mut c = Cadence::new(Duration::from_millis(100));
        let t0 = Instant::now();
        assert!(c.due(t0), "first call should fire");
        assert!(!c.due(t0), "same instant should not fire twice");
        assert!(!c.due(t0 + Duration::from_millis(50)));
        assert!(c.due(t0 + Duration::from_millis(100)));
    }

    #[test]
    fn sysctl_reads_a_known_key() {
        #[cfg(target_os = "macos")]
        {
            let total = sysctl_u64("hw.memsize").expect("hw.memsize exists on macOS");
            assert!(total > 1 << 30, "implausible memsize {total}");
            // 4-byte keys must not be read as garbage u64s.
            let cpus = sysctl_u64("hw.ncpu").expect("hw.ncpu exists");
            assert!((1..=1024).contains(&cpus), "implausible ncpu {cpus}");
        }
        assert_eq!(sysctl_u64("definitely.not.a.key"), None);
    }
}

/// Process CPU times from `proc_pidinfo` (`pti_total_user`/`pti_total_system`) are in
/// Mach absolute-time ticks, not nanoseconds. On Intel a tick is 1 ns; on Apple Silicon
/// it is 125/3 ns, so using ticks as nanoseconds undercounts a process's CPU 41.7 times.
#[cfg(target_os = "macos")]
pub fn mach_ticks_to_ns(ticks: u64) -> u64 {
    use std::sync::OnceLock;
    static TIMEBASE: OnceLock<(u64, u64)> = OnceLock::new();
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }
    let (numer, denom) = *TIMEBASE.get_or_init(|| {
        let mut info = Timebase { numer: 0, denom: 0 };
        // SAFETY: mach_timebase_info fills the struct it is given.
        let ok = unsafe { mach_timebase_info(&mut info) } == 0;
        if ok && info.numer > 0 && info.denom > 0 {
            (info.numer as u64, info.denom as u64)
        } else {
            (1, 1)
        }
    });
    ((ticks as u128 * numer as u128) / denom as u128) as u64
}

/// Elsewhere process CPU times are already nanoseconds.
#[cfg(not(target_os = "macos"))]
pub fn mach_ticks_to_ns(ticks: u64) -> u64 {
    ticks
}
