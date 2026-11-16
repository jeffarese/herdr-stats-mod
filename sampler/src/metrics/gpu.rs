//! GPU utilisation.
//!
//! On Apple Silicon (and on Macs with a discrete GPU) every `IOAccelerator`
//! service publishes a `PerformanceStatistics` dictionary whose
//! `Device Utilization %` is the same number Activity Monitor's GPU History
//! draws. No privileges are needed. The services are found once; each sample
//! copies one property per GPU.

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct GpuSample {
    /// Busy fraction of the busiest GPU, `0.0..=1.0`.
    pub busy: f32,
    /// Bytes of memory the GPU driver reports in use, when it says.
    pub memory: Option<u64>,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::GpuSample;
    use core_foundation_sys::base::{kCFAllocatorDefault, CFGetTypeID, CFRelease, CFTypeRef};
    use core_foundation_sys::dictionary::{
        CFDictionaryGetTypeID, CFDictionaryGetValue, CFDictionaryRef, CFMutableDictionaryRef,
    };
    use core_foundation_sys::number::{
        kCFNumberSInt64Type, CFNumberGetTypeID, CFNumberGetValue, CFNumberRef,
    };
    use core_foundation_sys::string::{
        kCFStringEncodingUTF8, CFStringCreateWithCString, CFStringRef,
    };
    use std::os::raw::{c_char, c_void};

    type IoObject = u32;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        // Declared as smc.rs declares it: one symbol, one signature.
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingServices(
            main_port: u32,
            matching: CFDictionaryRef,
            existing: *mut IoObject,
        ) -> i32;
        fn IOIteratorNext(iterator: IoObject) -> IoObject;
        fn IOObjectRelease(object: IoObject) -> i32;
        fn IORegistryEntryCreateCFProperty(
            entry: IoObject,
            key: CFStringRef,
            allocator: core_foundation_sys::base::CFAllocatorRef,
            options: u32,
        ) -> CFTypeRef;
    }

    pub struct GpuCollector {
        services: Vec<IoObject>,
        stats_key: CFStringRef,
        busy_key: CFStringRef,
        memory_key: CFStringRef,
    }

    // Touched only from the sampling thread.
    unsafe impl Send for GpuCollector {}

    fn cfstr(s: &str) -> CFStringRef {
        let c = std::ffi::CString::new(s).expect("no interior NUL");
        // SAFETY: a valid NUL-terminated UTF-8 string; the result is +1 and kept for our lifetime.
        unsafe { CFStringCreateWithCString(kCFAllocatorDefault, c.as_ptr(), kCFStringEncodingUTF8) }
    }

    impl GpuCollector {
        pub fn new() -> Option<Self> {
            let mut services = Vec::new();
            // SAFETY: IOServiceMatching returns a +1 dictionary that
            // IOServiceGetMatchingServices consumes. The iterator and every
            // entry it yields are released (entries when we drop).
            unsafe {
                let matching = IOServiceMatching(c"IOAccelerator".as_ptr());
                if matching.is_null() {
                    return None;
                }
                let mut iterator: IoObject = 0;
                if IOServiceGetMatchingServices(0, matching as CFMutableDictionaryRef as CFDictionaryRef, &mut iterator) != 0 {
                    return None;
                }
                loop {
                    let entry = IOIteratorNext(iterator);
                    if entry == 0 {
                        break;
                    }
                    services.push(entry);
                }
                IOObjectRelease(iterator);
            }
            if services.is_empty() {
                return None;
            }
            Some(Self {
                services,
                stats_key: cfstr("PerformanceStatistics"),
                busy_key: cfstr("Device Utilization %"),
                memory_key: cfstr("In use system memory"),
            })
        }

        pub fn sample(&mut self) -> Option<GpuSample> {
            let mut out: Option<GpuSample> = None;
            for &entry in &self.services {
                // SAFETY: the property is +1 (released below) and type-checked before use.
                unsafe {
                    let stats = IORegistryEntryCreateCFProperty(entry, self.stats_key, kCFAllocatorDefault, 0);
                    if stats.is_null() {
                        continue;
                    }
                    if CFGetTypeID(stats) == CFDictionaryGetTypeID() {
                        let dict = stats as CFDictionaryRef;
                        if let Some(busy) = number(dict, self.busy_key) {
                            let sample = out.get_or_insert_with(GpuSample::default);
                            sample.busy = sample.busy.max((busy as f32 / 100.0).clamp(0.0, 1.0));
                            if let Some(memory) = number(dict, self.memory_key) {
                                sample.memory = Some(sample.memory.unwrap_or(0) + memory.max(0) as u64);
                            }
                        }
                    }
                    CFRelease(stats);
                }
            }
            out
        }
    }

    unsafe fn number(dict: CFDictionaryRef, key: CFStringRef) -> Option<i64> {
        let value = CFDictionaryGetValue(dict, key as *const c_void);
        if value.is_null() || CFGetTypeID(value) != CFNumberGetTypeID() {
            return None;
        }
        let mut out: i64 = 0;
        let ok = CFNumberGetValue(value as CFNumberRef, kCFNumberSInt64Type, &mut out as *mut i64 as *mut c_void);
        ok.then_some(out)
    }

    impl Drop for GpuCollector {
        fn drop(&mut self) {
            // SAFETY: each entry and key was retained by us exactly once.
            unsafe {
                for &entry in &self.services {
                    IOObjectRelease(entry);
                }
                CFRelease(self.stats_key as CFTypeRef);
                CFRelease(self.busy_key as CFTypeRef);
                CFRelease(self.memory_key as CFTypeRef);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::GpuSample;

    /// No portable GPU counter without a vendor library; the mod hides the row.
    pub struct GpuCollector;

    impl GpuCollector {
        pub fn new() -> Option<Self> {
            None
        }
        pub fn sample(&mut self) -> Option<GpuSample> {
            None
        }
    }
}

pub use imp::GpuCollector;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gpu_reading_is_a_fraction_when_present() {
        if let Some(mut gpu) = GpuCollector::new() {
            if let Some(sample) = gpu.sample() {
                assert!((0.0..=1.0).contains(&sample.busy), "busy {}", sample.busy);
            }
        }
    }
}
