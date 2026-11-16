//! Memory from `host_statistics64`.
//!
//! "Used memory" on macOS is not total-minus-free. The compressor holds pages
//! that are resident but compressed, and inactive/purgeable pages are available
//! on demand. We report the number Activity Monitor calls Memory Used —
//! app + wired + compressed — because that is the number people recognise, and
//! carry the compressor and swap separately since those are the interesting
//! signals when a machine starts to hurt.

use std::io;

// No Eq: `pressure` is a float.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MemSample {
    pub total: u64,
    /// app + wired + compressed, matching Activity Monitor's "Memory Used".
    pub used: u64,
    pub wired: u64,
    /// Bytes currently held by the compressor.
    pub compressed: u64,
    pub swap_used: u64,
    /// Memory pressure in `0.0..=1.0`, when the kernel exposes it.
    pub pressure: Option<f32>,
}

impl MemSample {
    pub fn used_fraction(&self) -> f32 {
        if self.total == 0 {
            0.0
        } else {
            (self.used as f64 / self.total as f64).clamp(0.0, 1.0) as f32
        }
    }
}

#[cfg(target_os = "macos")]
mod ffi {
    use std::os::raw::{c_int, c_uint};

    pub const HOST_VM_INFO64: c_int = 4;
    // vm_statistics64_data_t is 38 u32-sized fields, but the tail is u64 counters.
    pub const HOST_VM_INFO64_COUNT: c_uint = 38;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct VmStatistics64 {
        pub free_count: u32,
        pub active_count: u32,
        pub inactive_count: u32,
        pub wire_count: u32,
        pub zero_fill_count: u64,
        pub reactivations: u64,
        pub pageins: u64,
        pub pageouts: u64,
        pub faults: u64,
        pub cow_faults: u64,
        pub lookups: u64,
        pub hits: u64,
        pub purges: u64,
        pub purgeable_count: u32,
        pub speculative_count: u32,
        pub decompressions: u64,
        pub compressions: u64,
        pub swapins: u64,
        pub swapouts: u64,
        pub compressor_page_count: u32,
        pub throttled_count: u32,
        pub external_page_count: u32,
        pub internal_page_count: u32,
        pub total_uncompressed_pages_in_compressor: u64,
    }

    extern "C" {
        pub fn mach_host_self() -> c_uint;
        pub fn host_statistics64(
            host: c_uint,
            flavor: c_int,
            host_info: *mut VmStatistics64,
            host_info_count: *mut c_uint,
        ) -> c_int;
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct XswUsage {
    xsu_total: u64,
    xsu_avail: u64,
    xsu_used: u64,
    xsu_pagesize: u32,
    xsu_encrypted: u8,
}

pub struct MemCollector {
    total: u64,
    /// Only macOS counts in pages; `/proc/meminfo` reports kilobytes directly.
    #[cfg(target_os = "macos")]
    page_size: u64,
}

impl MemCollector {
    pub fn new() -> Self {
        Self {
            total: super::sysctl_u64("hw.memsize").unwrap_or(0),
            #[cfg(target_os = "macos")]
            page_size: page_size(),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn sample(&mut self) -> io::Result<MemSample> {
        let mut stats = ffi::VmStatistics64::default();
        let mut count = ffi::HOST_VM_INFO64_COUNT;
        // SAFETY: `stats` is the flavor-matched struct and `count` its length in
        // u32 units, exactly as host_statistics64 expects.
        let status = unsafe {
            ffi::host_statistics64(
                ffi::mach_host_self(),
                ffi::HOST_VM_INFO64,
                &mut stats,
                &mut count,
            )
        };
        if status != 0 {
            return Err(io::Error::other(format!(
                "host_statistics64 failed (status {status})"
            )));
        }

        let page = self.page_size;
        let wired = stats.wire_count as u64 * page;
        let compressed = stats.compressor_page_count as u64 * page;
        // "App memory" is anonymous pages that are not the compressor's own.
        let app = (stats.internal_page_count as u64)
            .saturating_sub(stats.purgeable_count as u64)
            .saturating_mul(page);
        let used = (app + wired + compressed).min(self.total);

        Ok(MemSample {
            total: self.total,
            used,
            wired,
            compressed,
            swap_used: swap_used(),
            pressure: memory_pressure(),
        })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn sample(&mut self) -> io::Result<MemSample> {
        use std::io::BufRead;

        let file = std::fs::File::open("/proc/meminfo")?;
        let mut total = 0u64;
        let mut available = 0u64;
        let mut swap_total = 0u64;
        let mut swap_free = 0u64;
        for line in io::BufReader::new(file).lines() {
            let line = line?;
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let kb: u64 = value
                .split_whitespace()
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            match key {
                "MemTotal" => total = kb * 1024,
                "MemAvailable" => available = kb * 1024,
                "SwapTotal" => swap_total = kb * 1024,
                "SwapFree" => swap_free = kb * 1024,
                _ => {}
            }
        }
        self.total = total;
        Ok(MemSample {
            total,
            used: total.saturating_sub(available),
            wired: 0,
            compressed: 0,
            swap_used: swap_total.saturating_sub(swap_free),
            pressure: None,
        })
    }
}

impl Default for MemCollector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
fn swap_used() -> u64 {
    let mut usage = XswUsage::default();
    let mut size = std::mem::size_of::<XswUsage>();
    let name = c"vm.swapusage";
    // SAFETY: sysctlbyname fills at most `size` bytes into `usage`, and the
    // flavor matches the documented xsw_usage layout.
    let status = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            &mut usage as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status == 0 {
        usage.xsu_used
    } else {
        0
    }
}

/// `kern.memorystatus_level` is the percentage of memory the kernel considers
/// *available*, so pressure is its complement. It is undocumented but stable
/// and, unlike the dispatch pressure source, readable as a plain number.
#[cfg(target_os = "macos")]
fn memory_pressure() -> Option<f32> {
    let level = super::sysctl_u64("kern.memorystatus_level")?;
    let level = level.min(100) as f32;
    Some(((100.0 - level) / 100.0).clamp(0.0, 1.0))
}

#[cfg(target_os = "macos")]
fn page_size() -> u64 {
    // SAFETY: sysconf with a valid name has no preconditions.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if size > 0 {
        size as u64
    } else {
        4096
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_plausible_totals() {
        let mut c = MemCollector::new();
        let s = c.sample().expect("sample");
        assert!(s.total > 0, "total memory should be known");
        assert!(s.used > 0, "some memory is always in use");
        assert!(s.used <= s.total, "used {} > total {}", s.used, s.total);
        assert!((0.0..=1.0).contains(&s.used_fraction()));
    }

    #[test]
    fn used_fraction_is_zero_safe() {
        let s = MemSample::default();
        assert_eq!(s.used_fraction(), 0.0);
    }
}
