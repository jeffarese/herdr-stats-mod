//! Network throughput across the machine's physical interfaces.
//!
//! Counted on Ethernet and Wi-Fi (`en*` on macOS; everything but loopback and
//! virtual bridges on Linux), so traffic is not counted twice as it passes
//! through a VPN tunnel and then the link under it.

use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct NetSample {
    /// Bytes per second received since the previous sample.
    pub rx: f64,
    /// Bytes per second sent since the previous sample.
    pub tx: f64,
}

pub struct NetCollector {
    previous: HashMap<String, (u64, u64)>,
    last: Option<Instant>,
}

/// Interfaces whose traffic is real link traffic, not a tunnel or bridge on top of it.
pub fn counts(name: &str) -> bool {
    if cfg!(target_os = "macos") {
        return name.starts_with("en");
    }
    !(name == "lo"
        || name.starts_with("docker")
        || name.starts_with("br-")
        || name.starts_with("veth")
        || name.starts_with("virbr")
        || name.starts_with("tun")
        || name.starts_with("tailscale")
        || name.starts_with("wg"))
}

/// Difference between two readings of a counter that may have wrapped.
///
/// macOS keeps `if_data` counters in 32 bits, so a busy link wraps every few
/// seconds at 10 Gbit/s; a reading lower than the last is a wrap, not a reset.
pub fn delta(before: u64, now: u64, width: u32) -> u64 {
    if now >= before {
        now - before
    } else if width < 64 {
        (1u64 << width) - before + now
    } else {
        0
    }
}

impl NetCollector {
    pub fn new() -> Self {
        Self { previous: HashMap::new(), last: None }
    }

    /// The first call seeds the counters and reports zero.
    pub fn sample(&mut self) -> NetSample {
        let now = Instant::now();
        let current = read_counters();
        let elapsed = self.last.map(|t| now.duration_since(t).as_secs_f64()).unwrap_or(0.0);
        let mut rx = 0u64;
        let mut tx = 0u64;
        for (name, &(r, t)) in &current {
            if let Some(&(pr, pt)) = self.previous.get(name) {
                rx += delta(pr, r, COUNTER_BITS);
                tx += delta(pt, t, COUNTER_BITS);
            }
        }
        self.previous = current;
        self.last = Some(now);
        if elapsed <= 0.0 {
            return NetSample::default();
        }
        NetSample { rx: rx as f64 / elapsed, tx: tx as f64 / elapsed }
    }
}

impl Default for NetCollector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
const COUNTER_BITS: u32 = 32;
#[cfg(not(target_os = "macos"))]
const COUNTER_BITS: u32 = 64;

#[cfg(target_os = "macos")]
fn read_counters() -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs allocates a list we walk read-only and free once.
    unsafe {
        if libc::getifaddrs(&mut list) != 0 {
            return out;
        }
        let mut cursor = list;
        while !cursor.is_null() {
            let entry = &*cursor;
            cursor = entry.ifa_next;
            if entry.ifa_addr.is_null() || (*entry.ifa_addr).sa_family as i32 != libc::AF_LINK {
                continue;
            }
            let up = entry.ifa_flags & (libc::IFF_UP as u32) != 0;
            if !up || entry.ifa_data.is_null() {
                continue;
            }
            let name = std::ffi::CStr::from_ptr(entry.ifa_name).to_string_lossy().into_owned();
            if !counts(&name) {
                continue;
            }
            let data = &*(entry.ifa_data as *const libc::if_data);
            out.insert(name, (data.ifi_ibytes as u64, data.ifi_obytes as u64));
        }
        libc::freeifaddrs(list);
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn read_counters() -> HashMap<String, (u64, u64)> {
    parse_proc_net_dev(&std::fs::read_to_string("/proc/net/dev").unwrap_or_default())
}

/// `/proc/net/dev`: two header lines, then `name: rx_bytes … (8 fields) tx_bytes …`.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn parse_proc_net_dev(text: &str) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    for line in text.lines().skip(2) {
        let Some((name, rest)) = line.split_once(':') else { continue };
        let name = name.trim();
        if !counts(name) {
            continue;
        }
        let fields: Vec<u64> = rest.split_whitespace().filter_map(|f| f.parse().ok()).collect();
        if fields.len() >= 9 {
            out.insert(name.to_string(), (fields[0], fields[8]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wrapped_32_bit_counter_counts_the_bytes_across_the_wrap() {
        assert_eq!(delta(u32::MAX as u64 - 9, 5, 32), 15);
        assert_eq!(delta(100, 250, 32), 150);
    }

    #[test]
    fn a_64_bit_counter_that_went_down_was_reset_and_counts_nothing() {
        assert_eq!(delta(500, 10, 64), 0);
    }

    #[test]
    fn proc_net_dev_reads_receive_and_transmit_bytes() {
        let text = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n";
        let parsed = parse_proc_net_dev(text);
        if cfg!(target_os = "macos") {
            // On macOS only en* counts, so the Linux names are filtered out.
            assert!(parsed.is_empty());
        } else {
            assert_eq!(parsed.get("eth0"), Some(&(1000, 2000)));
            assert!(!parsed.contains_key("lo"));
        }
    }

    #[test]
    fn first_sample_is_zero() {
        let mut n = NetCollector::new();
        assert_eq!(n.sample(), NetSample::default());
    }
}
