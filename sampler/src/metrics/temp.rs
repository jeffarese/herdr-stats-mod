//! Temperatures from the AppleSensors HID usage page.
//!
//! `powermetrics` is the obvious source and it is root-only, which rules it out
//! for a plugin. The unprivileged route is IOKit's HID event system: sensors
//! publish on usage page 0xff00, usage 5, and each service answers a
//! temperature event with a float in degrees Celsius. These symbols are private
//! but have been present and stable for the whole Apple Silicon era; every
//! unprivileged Mac temperature tool uses them.
//!
//! Because they are private, every failure path here is non-fatal: a missing
//! symbol, an empty match, or a sensor that stops answering degrades to "no
//! temperature" rather than taking the daemon down.
//!
//! Sensor naming is per-SoC and undocumented. Observed on an M2 Max:
//!
//! ```text
//! PMU TP0s / TP1g / ...   CPU core cluster sensors    ~55-57 C
//! PMU tdie0..tdie10       SoC die sensors             ~56 C
//! PMU tdev1..tdev8        mixed device sensors        ~37-57 C
//! PMU tcal                calibration reference       (ignored)
//! NAND CH0 temp           SSD
//! gas gauge battery       battery
//! ```
//!
//! We take the max within each group rather than the mean: the hottest die is
//! what throttles, and averaging 64 sensors hides exactly the spike you opened
//! the dashboard to find. The CPU group additionally keeps its mean, because
//! there the two answer different questions — the max says something is about
//! to throttle, the mean says whether the whole package is hot or one cluster
//! is carrying the load. Both are published; neither replaces the other.

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TempSample {
    /// The hottest CPU cluster sensor. See the module doc for why max.
    pub cpu: Option<f32>,
    /// The mean across the CPU cluster sensors.
    ///
    /// The max says whether anything is about to throttle; the mean says
    /// whether the whole package is hot or one cluster is carrying the load.
    /// Folded incrementally, so this is the running mean rather than a sum.
    pub cpu_avg: Option<f32>,
    /// How many CPU sensors are in `cpu_avg` so far — fold state, not a reading.
    pub cpu_sensors: u32,
    pub soc: Option<f32>,
    pub gpu: Option<f32>,
    pub ssd: Option<f32>,
    pub battery: Option<f32>,
}

impl TempSample {
    /// The number to show when there is room for exactly one: the hottest of
    /// the compute sensors.
    pub fn headline(&self) -> Option<f32> {
        [self.cpu, self.gpu, self.soc]
            .into_iter()
            .flatten()
            .fold(None, |acc: Option<f32>, v| {
                Some(acc.map_or(v, |a| a.max(v)))
            })
    }
}

/// Which reading a sensor name contributes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Cpu,
    Soc,
    Gpu,
    Ssd,
    Battery,
    Ignored,
}

/// Classifies a sensor by name.
///
/// Kept as a free function over `&str` so the grouping rules are testable
/// without a Mac, an IOKit client, or the sensors being present. The names are
/// Apple's, so only the macOS collector consults it; hwmon exposes a chip name
/// instead and maps that directly.
#[cfg(any(target_os = "macos", test))]
pub fn classify(name: &str) -> Group {
    let lower = name.to_ascii_lowercase();
    let trimmed = lower.strip_prefix("pmu ").unwrap_or(&lower).trim();

    if trimmed.contains("battery") || trimmed.starts_with("gas gauge") {
        return Group::Battery;
    }
    if trimmed.contains("nand") || trimmed.contains("ssd") {
        return Group::Ssd;
    }
    // The calibration reference is not a real temperature.
    if trimmed == "tcal" {
        return Group::Ignored;
    }
    // TG* are GPU cluster sensors; TP* are CPU cluster sensors. Check GPU
    // first so a "tg" prefix is not eaten by the CPU rule.
    if starts_with_sensor_prefix(trimmed, "tg") {
        return Group::Gpu;
    }
    if starts_with_sensor_prefix(trimmed, "tp") {
        return Group::Cpu;
    }
    if trimmed.starts_with("tdie") {
        return Group::Soc;
    }
    // tdev sensors are a mixed bag across SoCs, and on an M2 Max they range
    // from 37 C (peripherals) to 57 C (die-adjacent). Attributing them to any
    // named group would be a guess, so they only inform nothing.
    Group::Ignored
}

/// True for names like `tp0s`, `tg1h` — a two-letter prefix followed by a digit.
#[cfg(any(target_os = "macos", test))]
fn starts_with_sensor_prefix(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
}

/// Folds one reading into the running maximum for its group.
pub fn accumulate(sample: &mut TempSample, group: Group, value: f32) {
    // Sensors occasionally answer with implausible values while a service is
    // waking up; drop anything outside a range a real machine can occupy.
    if !(-40.0..=150.0).contains(&value) {
        return;
    }
    if group == Group::Cpu {
        // Incremental mean: mean += (v - mean) / n. Keeps the fold to two
        // fields and never accumulates a sum that has to be divided later.
        sample.cpu_sensors += 1;
        let n = sample.cpu_sensors as f32;
        sample.cpu_avg = Some(match sample.cpu_avg {
            Some(mean) => mean + (value - mean) / n,
            None => value,
        });
    }
    let slot = match group {
        Group::Cpu => &mut sample.cpu,
        Group::Soc => &mut sample.soc,
        Group::Gpu => &mut sample.gpu,
        Group::Ssd => &mut sample.ssd,
        Group::Battery => &mut sample.battery,
        Group::Ignored => return,
    };
    *slot = Some(slot.map_or(value, |current| current.max(value)));
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{accumulate, classify, Group, TempSample};
    use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
    use core_foundation_sys::base::{CFAllocatorRef, CFRelease, CFTypeRef};
    use core_foundation_sys::dictionary::{
        kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFDictionaryCreate,
        CFDictionaryRef,
    };
    use core_foundation_sys::number::{kCFNumberIntType, CFNumberCreate};
    use core_foundation_sys::string::{
        kCFStringEncodingUTF8, CFStringCreateWithCString, CFStringGetCString, CFStringRef,
    };
    use std::os::raw::{c_char, c_int, c_void};

    enum IOHIDEventSystemClient {}
    enum IOHIDServiceClient {}
    enum IOHIDEvent {}

    type IOHIDEventSystemClientRef = *mut IOHIDEventSystemClient;
    type IOHIDServiceClientRef = *mut IOHIDServiceClient;
    type IOHIDEventRef = *mut IOHIDEvent;

    const K_IOHID_EVENT_TYPE_TEMPERATURE: i64 = 15;
    const PRIMARY_USAGE_PAGE_SENSOR: c_int = 0xff00;
    const PRIMARY_USAGE_TEMPERATURE: c_int = 5;

    /// IOHIDEventFieldBase: the event type shifted into the field's high half.
    const fn field_base(event_type: i64) -> i32 {
        (event_type << 16) as i32
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDEventSystemClientCreate(allocator: CFAllocatorRef) -> IOHIDEventSystemClientRef;
        fn IOHIDEventSystemClientSetMatching(
            client: IOHIDEventSystemClientRef,
            matching: CFDictionaryRef,
        );
        fn IOHIDEventSystemClientCopyServices(client: IOHIDEventSystemClientRef) -> CFArrayRef;
        fn IOHIDServiceClientCopyProperty(
            service: IOHIDServiceClientRef,
            key: CFStringRef,
        ) -> CFTypeRef;
        fn IOHIDServiceClientCopyEvent(
            service: IOHIDServiceClientRef,
            event_type: i64,
            options: i32,
            timestamp: i64,
        ) -> IOHIDEventRef;
        fn IOHIDEventGetFloatValue(event: IOHIDEventRef, field: i32) -> f64;
    }

    /// Holds the HID client and the resolved service list.
    ///
    /// Enumerating services is the expensive half (it walks the IO registry), so
    /// it happens once at construction; sampling then only copies an event per
    /// service. Sensor services do not come and go on a running machine.
    pub struct TempCollector {
        client: IOHIDEventSystemClientRef,
        /// (service, group) for every sensor we care about, pre-classified so
        /// the sampling path does no string work at all.
        services: Vec<(IOHIDServiceClientRef, Group)>,
        /// Retained so the service pointers above stay valid.
        service_array: CFArrayRef,
        /// Every named sensor, in `names` order, for diagnostics.
        all_services: Vec<IOHIDServiceClientRef>,
        names: Vec<(String, Group)>,
        /// AppleSMC, when it opens. The HID page has no per-core CPU diodes on
        /// Apple Silicon — its `PMU TP*` sensors read about ten degrees below
        /// them — so the CPU reading comes from here when it is available and
        /// falls back to HID when it is not.
        smc: Option<crate::metrics::smc::Smc>,
        /// The per-core keys this machine answers, resolved once.
        smc_cpu_keys: Vec<String>,
    }

    // The HID client is only ever touched from the sampling thread; the raw
    // pointers are not shared. Send lets the daemon own it inside a struct that
    // moves across thread boundaries at startup.
    unsafe impl Send for TempCollector {}

    impl TempCollector {
        pub fn new() -> Option<Self> {
            // SAFETY: every call below is the documented-by-convention private
            // IOKit HID API. Each returns either null (handled) or a +1 CF
            // reference that we release or retain deliberately.
            unsafe {
                let client = IOHIDEventSystemClientCreate(std::ptr::null());
                if client.is_null() {
                    return None;
                }

                let matching = match_dictionary()?;
                IOHIDEventSystemClientSetMatching(client, matching);
                CFRelease(matching as CFTypeRef);

                let service_array = IOHIDEventSystemClientCopyServices(client);
                if service_array.is_null() {
                    CFRelease(client as CFTypeRef);
                    return None;
                }

                let count = CFArrayGetCount(service_array);
                let mut services = Vec::with_capacity(count as usize);
                let mut all_services = Vec::with_capacity(count as usize);
                let mut names = Vec::with_capacity(count as usize);
                for i in 0..count {
                    let service = CFArrayGetValueAtIndex(service_array, i) as IOHIDServiceClientRef;
                    if service.is_null() {
                        continue;
                    }
                    let Some(name) = service_name(service) else {
                        continue;
                    };
                    let group = classify(&name);
                    names.push((name, group));
                    all_services.push(service);
                    if group != Group::Ignored {
                        services.push((service, group));
                    }
                }

                let smc = crate::metrics::smc::Smc::open();
                let smc_cpu_keys = smc.as_ref().map(|s| s.cpu_core_keys()).unwrap_or_default();

                Some(Self {
                    client,
                    services,
                    service_array,
                    all_services,
                    names,
                    smc,
                    smc_cpu_keys,
                })
            }
        }

        pub fn sample(&mut self) -> TempSample {
            // SMC wins for the CPU when it has the core diodes: it is the same
            // source every other temperature tool reads, so the number agrees
            // with what the user can check it against. The HID reading stays as
            // the fallback for machines where SMC does not open.
            //
            // Asking it *first* is what makes that cheap. Reading the HID CPU
            // services and then overwriting them cost a dozen IOKit round-trips
            // per tick — a quarter of this function's time — for values that
            // were discarded every time. Knowing the answer up front lets the
            // loop below skip them, while a machine where SMC has nothing to say
            // still falls through and reads them.
            let smc_cpu = self
                .smc
                .as_ref()
                .and_then(|smc| smc.cpu_temperature(&self.smc_cpu_keys));

            let mut out = TempSample::default();
            for &(service, group) in &self.services {
                if smc_cpu.is_some() && group == Group::Cpu {
                    continue;
                }
                // SAFETY: `service` is owned by `service_array`, which we hold a
                // reference to for our whole lifetime.
                if let Some(value) = unsafe { read_temperature(service) } {
                    accumulate(&mut out, group, value);
                }
            }

            if let Some((mean, max, count)) = smc_cpu {
                out.cpu = Some(max);
                out.cpu_avg = Some(mean);
                out.cpu_sensors = count;
            }
            out
        }

        /// Sensor names and their grouping, for `doctor`.
        pub fn inventory(&self) -> &[(String, Group)] {
            &self.names
        }

        /// The SMC keys feeding the CPU reading, for `doctor`. Empty means the
        /// CPU temperature is coming from the HID sensors instead.
        pub fn cpu_temp_keys(&self) -> &[String] {
            &self.smc_cpu_keys
        }

        /// Overrides the resolved key set from config.
        ///
        /// The key namespace is per-chip and undocumented, so a machine whose
        /// cores are named outside the candidate table stays fixable by config
        /// rather than needing a new build.
        pub fn set_cpu_temp_keys(&mut self, keys: Vec<String>) {
            if !keys.is_empty() {
                self.smc_cpu_keys = keys;
            }
        }

        /// Every sensor with its current reading, for `doctor`.
        ///
        /// Includes the ones we classify as `Ignored`: when a published number
        /// disagrees with what another tool shows, the answer is usually in the
        /// sensors we are *not* reading, and a name-only inventory cannot show
        /// that. Diagnostics only — the sampling path stays on the classified
        /// subset.
        pub fn readings(&mut self) -> Vec<(String, Group, Option<f32>)> {
            self.names
                .iter()
                .zip(self.all_services.iter())
                .map(|((name, group), &service)| {
                    (name.clone(), *group, unsafe { read_temperature(service) })
                })
                .collect()
        }
    }

    impl Drop for TempCollector {
        fn drop(&mut self) {
            // SAFETY: both were +1 references obtained in `new`.
            unsafe {
                if !self.service_array.is_null() {
                    CFRelease(self.service_array as CFTypeRef);
                }
                if !self.client.is_null() {
                    CFRelease(self.client as CFTypeRef);
                }
            }
        }
    }

    /// One temperature event from a sensor service, in degrees Celsius.
    ///
    /// # Safety
    /// `service` must be a live service owned by a retained service array.
    unsafe fn read_temperature(service: IOHIDServiceClientRef) -> Option<f32> {
        // The event is +1 and released immediately after reading its float.
        let event = IOHIDServiceClientCopyEvent(service, K_IOHID_EVENT_TYPE_TEMPERATURE, 0, 0);
        if event.is_null() {
            return None;
        }
        let value = IOHIDEventGetFloatValue(event, field_base(K_IOHID_EVENT_TYPE_TEMPERATURE));
        CFRelease(event as CFTypeRef);
        Some(value as f32)
    }

    /// `{ PrimaryUsagePage: 0xff00, PrimaryUsage: 5 }`
    unsafe fn match_dictionary() -> Option<CFDictionaryRef> {
        let page = PRIMARY_USAGE_PAGE_SENSOR;
        let usage = PRIMARY_USAGE_TEMPERATURE;
        let page_number = CFNumberCreate(
            std::ptr::null(),
            kCFNumberIntType,
            &page as *const _ as *const c_void,
        );
        let usage_number = CFNumberCreate(
            std::ptr::null(),
            kCFNumberIntType,
            &usage as *const _ as *const c_void,
        );
        let page_key = cfstr("PrimaryUsagePage")?;
        let usage_key = cfstr("PrimaryUsage")?;

        let keys = [page_key as *const c_void, usage_key as *const c_void];
        let values = [page_number as *const c_void, usage_number as *const c_void];
        let dict = CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            2,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );

        // The dictionary retains all four, so drop our own references.
        CFRelease(page_number as CFTypeRef);
        CFRelease(usage_number as CFTypeRef);
        CFRelease(page_key as CFTypeRef);
        CFRelease(usage_key as CFTypeRef);

        (!dict.is_null()).then_some(dict)
    }

    unsafe fn cfstr(value: &str) -> Option<CFStringRef> {
        let c = std::ffi::CString::new(value).ok()?;
        let s = CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), kCFStringEncodingUTF8);
        (!s.is_null()).then_some(s)
    }

    unsafe fn service_name(service: IOHIDServiceClientRef) -> Option<String> {
        let key = cfstr("Product")?;
        let value = IOHIDServiceClientCopyProperty(service, key);
        CFRelease(key as CFTypeRef);
        if value.is_null() {
            return None;
        }
        let mut buffer = [0 as c_char; 128];
        let ok = CFStringGetCString(
            value as CFStringRef,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            kCFStringEncodingUTF8,
        );
        CFRelease(value);
        if ok == 0 {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{accumulate, Group, TempSample};

    /// Linux exposes temperatures through hwmon, which needs no privileges and
    /// no private API. Zones are discovered once and read as plain files.
    pub struct TempCollector {
        zones: Vec<(std::path::PathBuf, Group)>,
        names: Vec<(String, Group)>,
    }

    impl TempCollector {
        pub fn new() -> Option<Self> {
            let mut zones = Vec::new();
            let mut names = Vec::new();
            let Ok(entries) = std::fs::read_dir("/sys/class/hwmon") else {
                return Some(Self { zones, names });
            };
            for entry in entries.flatten() {
                let base = entry.path();
                let chip = std::fs::read_to_string(base.join("name"))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                let group = match chip.as_str() {
                    // k10temp/coretemp are the CPU package sensors on AMD/Intel.
                    "k10temp" | "coretemp" | "cpu_thermal" => Group::Cpu,
                    // The SoC die on ARM boards, which is not the CPU package.
                    "soc_thermal" => Group::Soc,
                    "amdgpu" | "nouveau" | "i915" => Group::Gpu,
                    "nvme" | "drivetemp" => Group::Ssd,
                    "BAT0" | "battery" => Group::Battery,
                    _ => Group::Ignored,
                };
                if group == Group::Ignored {
                    names.push((chip, group));
                    continue;
                }
                for index in 1..=8 {
                    let input = base.join(format!("temp{index}_input"));
                    if input.exists() {
                        names.push((format!("{chip}/temp{index}"), group));
                        zones.push((input, group));
                    }
                }
            }
            Some(Self { zones, names })
        }

        pub fn sample(&mut self) -> TempSample {
            let mut out = TempSample::default();
            for (path, group) in &self.zones {
                let Ok(raw) = std::fs::read_to_string(path) else {
                    continue;
                };
                // hwmon reports millidegrees.
                if let Ok(milli) = raw.trim().parse::<f32>() {
                    accumulate(&mut out, *group, milli / 1000.0);
                }
            }
            out
        }

        pub fn inventory(&self) -> &[(String, Group)] {
            &self.names
        }

        /// No SMC outside macOS; the CPU reading comes from hwmon.
        pub fn cpu_temp_keys(&self) -> &[String] {
            &[]
        }

        /// Accepted and ignored, so callers need no target-specific code.
        pub fn set_cpu_temp_keys(&mut self, _keys: Vec<String>) {}

        /// Every zone with its current reading, for `doctor`. Ignored chips have
        /// no file to read, so they report `None`.
        pub fn readings(&mut self) -> Vec<(String, Group, Option<f32>)> {
            self.names
                .iter()
                .map(|(name, group)| {
                    let value = self
                        .zones
                        .iter()
                        .find(|(path, _)| {
                            path.to_string_lossy()
                                .contains(name.rsplit('/').next().unwrap_or(""))
                        })
                        .and_then(|(path, _)| std::fs::read_to_string(path).ok())
                        .and_then(|raw| raw.trim().parse::<f32>().ok())
                        .map(|milli| milli / 1000.0);
                    (name.clone(), *group, value)
                })
                .collect()
        }
    }
}

pub use imp::TempCollector;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_observed_m2_max_sensor_names() {
        // Exactly the names read off the machine this was written on.
        assert_eq!(classify("PMU TP0s"), Group::Cpu);
        assert_eq!(classify("PMU TP3g"), Group::Cpu);
        assert_eq!(classify("PMU tdie0"), Group::Soc);
        assert_eq!(classify("PMU tdie10"), Group::Soc);
        assert_eq!(classify("NAND CH0 temp"), Group::Ssd);
        assert_eq!(classify("gas gauge battery"), Group::Battery);
        assert_eq!(classify("PMU tcal"), Group::Ignored);
        // tdev sensors span peripherals and die-adjacent points; unattributable.
        assert_eq!(classify("PMU tdev3"), Group::Ignored);
    }

    #[test]
    fn gpu_prefix_is_not_eaten_by_the_cpu_rule() {
        assert_eq!(classify("PMU TG0H"), Group::Gpu);
        assert_eq!(classify("PMU TG1h"), Group::Gpu);
    }

    #[test]
    fn sensor_prefix_requires_a_trailing_digit() {
        // "tp" alone, or a word merely starting with those letters, is not a
        // cluster sensor.
        assert_eq!(classify("tpanel"), Group::Ignored);
        assert_eq!(classify("tp"), Group::Ignored);
    }

    #[test]
    fn accumulate_keeps_the_hottest_reading_per_group() {
        let mut s = TempSample::default();
        accumulate(&mut s, Group::Cpu, 55.0);
        accumulate(&mut s, Group::Cpu, 57.5);
        accumulate(&mut s, Group::Cpu, 51.0);
        assert_eq!(s.cpu, Some(57.5));
    }

    #[test]
    fn accumulate_also_tracks_the_cpu_mean() {
        let mut s = TempSample::default();
        for value in [50.0, 60.0, 55.0] {
            accumulate(&mut s, Group::Cpu, value);
        }
        // The max is what throttles; the mean is what says whether one cluster
        // is carrying the machine or all of them are hot.
        assert_eq!(s.cpu, Some(60.0));
        assert_eq!(s.cpu_sensors, 3);
        let avg = s.cpu_avg.expect("mean");
        assert!((avg - 55.0).abs() < 0.001, "got {avg}");

        // Only CPU sensors feed it, and a rejected reading must not move it.
        accumulate(&mut s, Group::Gpu, 90.0);
        accumulate(&mut s, Group::Cpu, 4000.0);
        assert_eq!(s.cpu_sensors, 3);
        assert!((s.cpu_avg.unwrap() - 55.0).abs() < 0.001);
    }

    #[test]
    fn accumulate_rejects_implausible_readings() {
        let mut s = TempSample::default();
        // Sensors can answer 0 or garbage while a service is waking up.
        accumulate(&mut s, Group::Cpu, 4000.0);
        accumulate(&mut s, Group::Cpu, -273.0);
        assert_eq!(s.cpu, None);
        accumulate(&mut s, Group::Cpu, 48.0);
        assert_eq!(s.cpu, Some(48.0));
    }

    #[test]
    fn headline_prefers_the_hottest_compute_sensor() {
        let s = TempSample {
            cpu: Some(56.0),
            cpu_avg: Some(54.0),
            cpu_sensors: 4,
            gpu: Some(61.0),
            soc: Some(55.0),
            ssd: Some(38.0),
            battery: Some(37.0),
        };
        // SSD and battery are cooler and also not what throttles the machine.
        assert_eq!(s.headline(), Some(61.0));
        assert_eq!(TempSample::default().headline(), None);
    }

    #[test]
    fn ignored_group_never_lands_in_a_slot() {
        let mut s = TempSample::default();
        accumulate(&mut s, Group::Ignored, 50.0);
        assert_eq!(s, TempSample::default());
    }
}
