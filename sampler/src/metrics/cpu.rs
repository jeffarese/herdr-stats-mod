//! Per-core CPU load from `host_processor_info`.
//!
//! The kernel reports monotonic tick counters per core, so a reading on its own
//! is meaningless; load is the delta between two samples. We keep the previous
//! tick table and diff into a caller-owned buffer, which keeps the whole sample
//! allocation-free after the first tick.
//!
//! Apple Silicon mixes performance and efficiency cores in one flat array. The
//! split matters: 30% spread over efficiency cores and 30% pinned to a
//! performance core are very different machine states. `hw.perflevel*` gives us
//! the boundary, and the array is ordered P-cores first.

use std::io;

#[cfg(target_os = "macos")]
mod ffi {
    use std::os::raw::{c_int, c_uint};

    pub const PROCESSOR_CPU_LOAD_INFO: c_int = 2;
    pub const CPU_STATE_MAX: usize = 4;
    pub const CPU_STATE_USER: usize = 0;
    pub const CPU_STATE_SYSTEM: usize = 1;
    pub const CPU_STATE_IDLE: usize = 2;
    pub const CPU_STATE_NICE: usize = 3;

    extern "C" {
        pub fn mach_host_self() -> c_uint;
        pub fn host_processor_info(
            host: c_uint,
            flavor: c_int,
            out_processor_count: *mut c_uint,
            out_processor_info: *mut *mut c_int,
            out_processor_infoCnt: *mut c_uint,
        ) -> c_int;
        pub fn vm_deallocate(target_task: c_uint, address: usize, size: usize) -> c_int;
        pub fn mach_task_self() -> c_uint;
    }
}

/// One core's busy fraction in `0.0..=1.0`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CoreLoad {
    pub busy: f32,
}

#[derive(Debug, Default, Clone)]
pub struct CpuSample {
    /// Per-core busy fraction, in kernel core order (P-cores first on Apple Silicon).
    pub cores: Vec<CoreLoad>,
    /// Busy fraction across every core.
    pub total: f32,
    /// Busy fraction across performance cores, when the split is known.
    pub performance: Option<f32>,
    /// Busy fraction across efficiency cores, when the split is known.
    pub efficiency: Option<f32>,
    /// How many leading cores are performance cores, when the split is known.
    ///
    /// Carried on the sample rather than left in the collector because every
    /// per-core rendering needs it: a row of core cells means something quite
    /// different if you cannot see where the efficiency cluster starts.
    pub performance_cores: Option<usize>,
}

impl CpuSample {
    /// The single busiest core.
    ///
    /// A twelve-core machine with one pinned core reads 8% overall, which looks
    /// idle and is not: that one thread is at its ceiling and whatever is
    /// waiting on it is stuck. The aggregate cannot show that; this can.
    pub fn busiest_core(&self) -> Option<f32> {
        self.cores
            .iter()
            .map(|c| c.busy)
            .fold(None, |acc: Option<f32>, v| {
                Some(acc.map_or(v, |a| a.max(v)))
            })
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct Ticks {
    busy: u64,
    total: u64,
}

pub struct CpuCollector {
    previous: Vec<Ticks>,
    /// Number of leading cores that are performance cores, if we could tell.
    performance_cores: Option<usize>,
    scratch: Vec<Ticks>,
}

impl CpuCollector {
    pub fn new() -> Self {
        Self {
            previous: Vec::new(),
            performance_cores: detect_performance_core_count(),
            scratch: Vec::new(),
        }
    }

    /// Samples the tick counters and writes the delta into `out`.
    ///
    /// The first call after construction has no baseline to diff against, so it
    /// reports zero load and seeds the counters. Callers should discard it.
    pub fn sample(&mut self, out: &mut CpuSample) -> io::Result<()> {
        self.read_ticks()?;

        let n = self.scratch.len();
        out.cores.resize(n, CoreLoad::default());

        let seeding = self.previous.len() != n;
        let mut busy_sum = 0u64;
        let mut total_sum = 0u64;
        let mut perf_busy = 0u64;
        let mut perf_total = 0u64;
        let mut eff_busy = 0u64;
        let mut eff_total = 0u64;
        let boundary = self.performance_cores.unwrap_or(n);

        for i in 0..n {
            let now = self.scratch[i];
            let (busy, total) = if seeding {
                (0, 0)
            } else {
                let before = self.previous[i];
                (
                    now.busy.saturating_sub(before.busy),
                    now.total.saturating_sub(before.total),
                )
            };
            out.cores[i].busy = fraction(busy, total);
            busy_sum += busy;
            total_sum += total;
            if i < boundary {
                perf_busy += busy;
                perf_total += total;
            } else {
                eff_busy += busy;
                eff_total += total;
            }
        }

        out.total = fraction(busy_sum, total_sum);
        out.performance_cores = self.performance_cores;
        out.performance = (self.performance_cores.is_some() && perf_total > 0)
            .then(|| fraction(perf_busy, perf_total));
        out.efficiency = (self.performance_cores.is_some() && eff_total > 0)
            .then(|| fraction(eff_busy, eff_total));

        std::mem::swap(&mut self.previous, &mut self.scratch);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn read_ticks(&mut self) -> io::Result<()> {
        let mut count: u32 = 0;
        let mut info: *mut i32 = std::ptr::null_mut();
        let mut info_count: u32 = 0;

        // SAFETY: host_processor_info allocates the info array in our address
        // space and reports its length; we hand both straight back to
        // vm_deallocate below and never retain the pointer.
        let status = unsafe {
            ffi::host_processor_info(
                ffi::mach_host_self(),
                ffi::PROCESSOR_CPU_LOAD_INFO,
                &mut count,
                &mut info,
                &mut info_count,
            )
        };
        if status != 0 || info.is_null() {
            return Err(io::Error::other(format!(
                "host_processor_info failed (status {status})"
            )));
        }

        let cores = count as usize;
        self.scratch.clear();
        self.scratch.reserve(cores);
        for core in 0..cores {
            let base = core * ffi::CPU_STATE_MAX;
            // SAFETY: the kernel guarantees `count * CPU_STATE_MAX` entries,
            // and `base + CPU_STATE_NICE` is the last index we touch.
            let read = |state: usize| unsafe { *info.add(base + state) as u32 as u64 };
            let user = read(ffi::CPU_STATE_USER);
            let system = read(ffi::CPU_STATE_SYSTEM);
            let idle = read(ffi::CPU_STATE_IDLE);
            let nice = read(ffi::CPU_STATE_NICE);
            let busy = user + system + nice;
            self.scratch.push(Ticks {
                busy,
                total: busy + idle,
            });
        }

        // SAFETY: matching deallocation for the buffer above, with the length
        // the kernel reported (info_count is in units of i32).
        unsafe {
            ffi::vm_deallocate(
                ffi::mach_task_self(),
                info as usize,
                info_count as usize * std::mem::size_of::<i32>(),
            );
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    fn read_ticks(&mut self) -> io::Result<()> {
        use std::io::BufRead;

        let file = std::fs::File::open("/proc/stat")?;
        self.scratch.clear();
        for line in io::BufReader::new(file).lines() {
            let line = line?;
            // "cpu" is the aggregate row; "cpuN" are the per-core rows we want.
            let Some(rest) = line.strip_prefix("cpu") else {
                break;
            };
            if rest.starts_with(' ') {
                continue;
            }
            let Some((_, fields)) = rest.split_once(' ') else {
                continue;
            };
            let mut total = 0u64;
            let mut idle = 0u64;
            for (i, field) in fields.split_whitespace().enumerate() {
                let value: u64 = field.parse().unwrap_or(0);
                total += value;
                // Fields 3 and 4 are idle and iowait.
                if i == 3 || i == 4 {
                    idle += value;
                }
            }
            self.scratch.push(Ticks {
                busy: total.saturating_sub(idle),
                total,
            });
        }
        Ok(())
    }
}

impl Default for CpuCollector {
    fn default() -> Self {
        Self::new()
    }
}

fn fraction(busy: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        (busy as f64 / total as f64).clamp(0.0, 1.0) as f32
    }
}

/// Number of performance cores, which is also the index where efficiency cores
/// begin. `hw.perflevel0` is the fastest level on Apple Silicon; the sysctl is
/// absent on Intel Macs and Linux, where the split is meaningless anyway.
#[cfg(target_os = "macos")]
fn detect_performance_core_count() -> Option<usize> {
    let levels = crate::metrics::sysctl_u64("hw.nperflevels")?;
    if levels < 2 {
        return None;
    }
    let perf = crate::metrics::sysctl_u64("hw.perflevel0.logicalcpu")?;
    (perf > 0).then_some(perf as usize)
}

#[cfg(not(target_os = "macos"))]
fn detect_performance_core_count() -> Option<usize> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn busiest_core_finds_the_pinned_one() {
        let sample = CpuSample {
            cores: vec![
                CoreLoad { busy: 0.02 },
                CoreLoad { busy: 0.99 },
                CoreLoad { busy: 0.05 },
            ],
            total: 0.35,
            ..Default::default()
        };
        // The aggregate says "idle"; one thread is at its ceiling.
        assert_eq!(sample.busiest_core(), Some(0.99));
        assert_eq!(CpuSample::default().busiest_core(), None);
    }

    use super::*;

    #[test]
    fn fraction_is_clamped_and_zero_safe() {
        assert_eq!(fraction(0, 0), 0.0);
        assert_eq!(fraction(1, 2), 0.5);
        // Counters can appear to move backwards across a sleep/wake boundary;
        // saturating_sub already floors the delta, but guard the ratio too.
        assert_eq!(fraction(5, 2), 1.0);
    }

    #[test]
    fn first_sample_reports_zero_and_seeds() {
        let mut c = CpuCollector::new();
        let mut s = CpuSample::default();
        c.sample(&mut s).expect("sample");
        assert!(!s.cores.is_empty(), "expected at least one core");
        assert_eq!(s.total, 0.0, "seeding sample must not invent load");
        assert_eq!(c.previous.len(), s.cores.len());
    }

    #[test]
    fn second_sample_produces_a_real_reading() {
        let mut c = CpuCollector::new();
        let mut s = CpuSample::default();
        c.sample(&mut s).expect("seed");
        // Burn a little CPU so the delta is not entirely idle.
        let mut acc = 0u64;
        for i in 0..2_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        std::hint::black_box(acc);
        c.sample(&mut s).expect("sample");
        assert!((0.0..=1.0).contains(&s.total), "total was {}", s.total);
        assert!(s.cores.iter().all(|c| (0.0..=1.0).contains(&c.busy)));
    }

    #[test]
    fn performance_core_count_is_plausible_when_detected() {
        // On Apple Silicon this is the index where efficiency cores begin, so
        // it must be inside the core array, never equal to or past its end.
        let mut c = CpuCollector::new();
        let mut s = CpuSample::default();
        c.sample(&mut s).expect("sample");
        if let Some(boundary) = c.performance_cores {
            assert!(
                boundary > 0 && boundary < s.cores.len(),
                "boundary {boundary}"
            );
        }
    }
}
