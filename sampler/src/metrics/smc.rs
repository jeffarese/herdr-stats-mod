//! Temperatures from AppleSMC.
//!
//! The HID sensor page (see `temp`) is unprivileged and easy, but on Apple
//! Silicon it does not expose the per-core CPU diodes — its `PMU TP*` sensors
//! read roughly ten degrees below them. Every tool that shows a per-core CPU
//! temperature (Stats, TG Pro, iStat Menus) reads AppleSMC instead, so matching
//! what those report means reading the same source.
//!
//! SMC is a key-value store reached through an IOKit user client. Keys are
//! four-character codes; a read is two round-trips, one for the key's type and
//! size and one for its bytes. `#KEY` holds the key count and `READ_INDEX`
//! walks them, which is how we discover what a given machine actually has
//! rather than hardcoding a per-chip table that goes stale every generation.
//!
//! Like the HID module, every failure path here is non-fatal: no service, a
//! closed connection, or a key that stops answering degrades to "no reading".

#![cfg(target_os = "macos")]

use std::os::raw::{c_char, c_uint, c_void};

/// `IOConnectCallStructMethod` selector for the SMC user client.
const KERNEL_INDEX_SMC: u32 = 2;
const SMC_CMD_READ_BYTES: u8 = 5;
const SMC_CMD_READ_INDEX: u8 = 8;
const SMC_CMD_READ_KEYINFO: u8 = 9;

/// Four-character type codes, as they arrive from the kernel.
const TYPE_FLT: u32 = fourcc(b"flt ");
const TYPE_SP78: u32 = fourcc(b"sp78");
const TYPE_UI8: u32 = fourcc(b"ui8 ");
const TYPE_UI16: u32 = fourcc(b"ui16");
const TYPE_UI32: u32 = fourcc(b"ui32");

const fn fourcc(bytes: &[u8; 4]) -> u32 {
    ((bytes[0] as u32) << 24)
        | ((bytes[1] as u32) << 16)
        | ((bytes[2] as u32) << 8)
        | bytes[3] as u32
}

fn fourcc_of(name: &str) -> u32 {
    let mut out = [b' '; 4];
    for (slot, byte) in out.iter_mut().zip(name.bytes()) {
        *slot = byte;
    }
    fourcc(&out)
}

fn name_of(key: u32) -> String {
    key.to_be_bytes()
        .iter()
        .map(|&b| if b.is_ascii_graphic() { b as char } else { '?' })
        .collect()
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Version {
    major: u8,
    minor: u8,
    build: u8,
    reserved: u8,
    release: u16,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct PLimitData {
    version: u16,
    length: u16,
    cpu_plimit: u32,
    gpu_plimit: u32,
    mem_plimit: u32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct KeyInfo {
    data_size: u32,
    data_type: u32,
    data_attributes: u8,
}

/// The one struct every SMC call passes in both directions.
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct KeyData {
    key: u32,
    version: Version,
    p_limit: PLimitData,
    key_info: KeyInfo,
    result: u8,
    status: u8,
    data8: u8,
    data32: u32,
    bytes: [u8; 32],
}

#[allow(non_camel_case_types)]
type io_object_t = c_uint;
#[allow(non_camel_case_types)]
type io_connect_t = c_uint;
type IOReturn = i32;

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOServiceMatching(name: *const c_char) -> *mut c_void;
    fn IOServiceGetMatchingService(main_port: c_uint, matching: *mut c_void) -> io_object_t;
    fn IOServiceOpen(
        service: io_object_t,
        owning_task: c_uint,
        type_: u32,
        connect: *mut io_connect_t,
    ) -> IOReturn;
    fn IOServiceClose(connect: io_connect_t) -> IOReturn;
    fn IOObjectRelease(object: io_object_t) -> IOReturn;
    fn IOConnectCallStructMethod(
        connection: io_connect_t,
        selector: u32,
        input: *const c_void,
        input_size: usize,
        output: *mut c_void,
        output_size: *mut usize,
    ) -> IOReturn;
    fn mach_task_self() -> c_uint;
}

/// An open connection to AppleSMC.
pub struct Smc {
    connection: io_connect_t,
}

// The connection is only ever touched from the sampling thread.
unsafe impl Send for Smc {}

impl Smc {
    pub fn open() -> Option<Self> {
        // SAFETY: standard IOKit service lookup. `IOServiceGetMatchingService`
        // consumes the matching dictionary, so we must not release it.
        unsafe {
            let name = std::ffi::CString::new("AppleSMC").ok()?;
            let matching = IOServiceMatching(name.as_ptr());
            if matching.is_null() {
                return None;
            }
            // 0 is kIOMainPortDefault.
            let service = IOServiceGetMatchingService(0, matching);
            if service == 0 {
                return None;
            }
            let mut connection: io_connect_t = 0;
            let status = IOServiceOpen(service, mach_task_self(), 0, &mut connection);
            IOObjectRelease(service);
            if status != 0 || connection == 0 {
                return None;
            }
            Some(Self { connection })
        }
    }

    fn call(&self, input: &KeyData) -> Option<KeyData> {
        let mut output = KeyData::default();
        let mut output_size = std::mem::size_of::<KeyData>();
        // SAFETY: both structs are `repr(C)` and sized exactly as the kernel
        // expects; the call neither retains nor frees them.
        let status = unsafe {
            IOConnectCallStructMethod(
                self.connection,
                KERNEL_INDEX_SMC,
                input as *const KeyData as *const c_void,
                std::mem::size_of::<KeyData>(),
                &mut output as *mut KeyData as *mut c_void,
                &mut output_size,
            )
        };
        // `result` is the SMC's own status byte; a non-zero one means the key
        // is absent or unreadable, which is not an error worth propagating.
        (status == 0 && output.result == 0).then_some(output)
    }

    /// Reads a key as a number, whatever numeric type the SMC stores it in.
    pub fn read(&self, name: &str) -> Option<f32> {
        let key = fourcc_of(name);
        let info = self.call(&KeyData {
            key,
            data8: SMC_CMD_READ_KEYINFO,
            ..Default::default()
        })?;
        let value = self.call(&KeyData {
            key,
            key_info: info.key_info,
            data8: SMC_CMD_READ_BYTES,
            ..Default::default()
        })?;
        decode(
            info.key_info.data_type,
            info.key_info.data_size,
            &value.bytes,
        )
    }

    /// Every key the SMC exposes, in index order.
    ///
    /// Key sets are per-chip and undocumented, so discovery beats a hardcoded
    /// table: a machine that names its cores differently still works, and
    /// `doctor` can show what is actually there.
    pub fn keys(&self) -> Vec<String> {
        let Some(count) = self.read("#KEY") else {
            return Vec::new();
        };
        let count = count as u32;
        // A plausible ceiling; a garbage count must not spin the loop forever.
        let count = count.min(4096);
        (0..count)
            .filter_map(|index| {
                let out = self.call(&KeyData {
                    data8: SMC_CMD_READ_INDEX,
                    data32: index,
                    ..Default::default()
                })?;
                Some(name_of(out.key))
            })
            .collect()
    }
}

/// Per-core CPU temperature keys, as a union across Apple Silicon generations.
///
/// The key namespace is undocumented and per-chip, so this is a candidate list
/// filtered against what a given machine actually answers rather than a table
/// that has to be right. An M2 Max resolves twelve of these — eight performance
/// cores and four efficiency cores — which is what tools like Stats average to
/// get their "Average CPU" reading.
///
/// If a future chip names its cores differently, `herdr-stats sensors` shows
/// every key on the machine and `[sensors] cpu_temp_keys` overrides this
/// without a rebuild.
pub const CPU_CORE_KEY_CANDIDATES: &[&str] = &[
    // M1 and M1 Pro/Max performance cores.
    "Tp01", "Tp05", "Tp09", "Tp0D", "Tp0H", "Tp0L", "Tp0P", "Tp0X", "Tp0b", "Tp0f", "Tp0j",
    // M1 efficiency cores.
    "Tp0T", // M2 Pro/Max efficiency cores.
    "Tp1h", "Tp1l", "Tp1p", "Tp1t",
];

/// A plausible temperature for a running machine. Sensors that are absent
/// answer 0 rather than failing, so a range check is what actually rejects them.
const PLAUSIBLE: std::ops::RangeInclusive<f32> = 1.0..=150.0;

impl Smc {
    /// The per-core CPU keys this machine actually answers.
    pub fn cpu_core_keys(&self) -> Vec<String> {
        CPU_CORE_KEY_CANDIDATES
            .iter()
            .filter(|key| self.read(key).is_some_and(|v| PLAUSIBLE.contains(&v)))
            .map(|key| (*key).to_string())
            .collect()
    }

    /// Mean and hottest across the given keys, skipping any that stop answering.
    pub fn cpu_temperature(&self, keys: &[String]) -> Option<(f32, f32, u32)> {
        let mut sum = 0.0;
        let mut max = f32::MIN;
        let mut count = 0u32;
        for key in keys {
            let Some(value) = self.read(key).filter(|v| PLAUSIBLE.contains(v)) else {
                continue;
            };
            sum += value;
            max = max.max(value);
            count += 1;
        }
        (count > 0).then(|| (sum / count as f32, max, count))
    }
}

impl Drop for Smc {
    fn drop(&mut self) {
        // SAFETY: the connection was opened in `open` and is closed once.
        unsafe {
            IOServiceClose(self.connection);
        }
    }
}

fn decode(data_type: u32, size: u32, bytes: &[u8; 32]) -> Option<f32> {
    match data_type {
        // Apple Silicon temperatures are little-endian floats.
        TYPE_FLT if size == 4 => Some(f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])),
        // Intel-era fixed point: signed 8.8, big-endian.
        TYPE_SP78 if size == 2 => Some(i16::from_be_bytes([bytes[0], bytes[1]]) as f32 / 256.0),
        TYPE_UI8 if size == 1 => Some(bytes[0] as f32),
        TYPE_UI16 if size == 2 => Some(u16::from_be_bytes([bytes[0], bytes[1]]) as f32),
        TYPE_UI32 if size == 4 => {
            Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourcc_round_trips_a_key_name() {
        assert_eq!(name_of(fourcc_of("Tp01")), "Tp01");
        // Short names are space-padded, the way the SMC stores them.
        assert_eq!(name_of(fourcc_of("#KEY")), "#KEY");
    }

    #[test]
    fn decodes_every_numeric_type_we_ask_for() {
        let mut bytes = [0u8; 32];
        bytes[..4].copy_from_slice(&61.4f32.to_le_bytes());
        assert_eq!(decode(TYPE_FLT, 4, &bytes), Some(61.4));

        // sp78 is big-endian 8.8 fixed point: 0x3D80 is 61.5.
        let mut bytes = [0u8; 32];
        bytes[..2].copy_from_slice(&[0x3d, 0x80]);
        assert_eq!(decode(TYPE_SP78, 2, &bytes), Some(61.5));

        // A type we do not understand must read as absent, never as zero.
        assert_eq!(decode(fourcc(b"ch8*"), 8, &bytes), None);
        // A size that disagrees with the type is corrupt, not a reading.
        assert_eq!(decode(TYPE_FLT, 2, &bytes), None);
    }

    #[test]
    fn the_candidate_table_covers_a_whole_machine() {
        // Eight performance cores plus four efficiency cores is what an M2 Max
        // resolves; the table has to hold at least that many distinct keys.
        assert!(CPU_CORE_KEY_CANDIDATES.len() >= 12);
        let mut sorted = CPU_CORE_KEY_CANDIDATES.to_vec();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        // A duplicate would weight one core twice in the mean.
        assert_eq!(sorted.len(), before, "duplicate key in the candidate table");
        assert!(CPU_CORE_KEY_CANDIDATES
            .iter()
            .all(|k| k.len() == 4 && k.starts_with("Tp")));
    }

    /// Reads the real SMC when there is one. Skipped in CI and on Intel, where
    /// the point of the test — that the resolved keys look like a whole CPU —
    /// cannot be checked at all.
    #[test]
    fn resolves_a_plausible_core_set_on_this_machine() {
        let Some(smc) = Smc::open() else { return };
        let keys = smc.cpu_core_keys();
        if keys.is_empty() {
            return;
        }
        let (mean, max, count) = smc.cpu_temperature(&keys).expect("a reading");
        assert_eq!(count as usize, keys.len());
        assert!(mean <= max, "mean {mean} above max {max}");
        // A running Mac sits well inside this; anything outside means the
        // decode is wrong, not that the machine is unusual.
        assert!(
            (20.0..110.0).contains(&mean),
            "implausible mean {mean} from {keys:?}"
        );
    }

    #[test]
    fn key_data_matches_the_kernel_layout() {
        // The kernel copies this struct in and out verbatim; a layout change
        // would silently read garbage rather than fail.
        assert_eq!(std::mem::size_of::<KeyData>(), 80);
    }
}
