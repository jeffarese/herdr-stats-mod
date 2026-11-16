//! The JSON the mod reads, and the history carried from one sampler to the next.
//!
//! The mod runs the sampler through Herdr's `exec`, which caps a program at ten
//! minutes, so a sampler retires itself before that and the next one picks up
//! the charts from the last snapshot it left behind. The person never sees the
//! history restart.

use serde_json::{json, Map, Value};
use std::collections::VecDeque;

/// Samples kept per chart: three minutes at one a second.
pub const HISTORY: usize = 180;

/// Rounds for the wire: three decimals is a tenth of a percent, which no chart can show.
pub fn r3(x: f64) -> f64 {
    if !x.is_finite() {
        return 0.0;
    }
    (x * 1000.0).round() / 1000.0
}

pub fn r1(x: f64) -> f64 {
    if !x.is_finite() {
        return 0.0;
    }
    (x * 10.0).round() / 10.0
}

#[derive(Debug, Default, Clone)]
pub struct Histories {
    pub cpu: VecDeque<f64>,
    pub mem: VecDeque<f64>,
    pub gpu: VecDeque<f64>,
    pub rx: VecDeque<f64>,
    pub tx: VecDeque<f64>,
}

impl Histories {
    pub fn push(series: &mut VecDeque<f64>, value: f64) {
        if series.len() >= HISTORY {
            series.pop_front();
        }
        series.push_back(value);
    }

    pub fn to_json(&self) -> Value {
        let list = |s: &VecDeque<f64>, round: fn(f64) -> f64| Value::from(s.iter().map(|v| round(*v)).collect::<Vec<_>>());
        json!({
            "cpu": list(&self.cpu, r3),
            "mem": list(&self.mem, r3),
            "gpu": list(&self.gpu, r3),
            "rx": list(&self.rx, f64::round),
            "tx": list(&self.tx, f64::round),
        })
    }

    /// The history in an earlier snapshot, if it is recent enough to continue.
    ///
    /// `now_ms - t` beyond `max_gap_ms` means the machine slept or nothing ran
    /// for a while: a chart that joined across the gap would draw a lie.
    pub fn resume(text: &str, now_ms: u64, max_gap_ms: u64) -> Self {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return Self::default();
        };
        let t = value.get("t").and_then(Value::as_u64).unwrap_or(0);
        if t == 0 || now_ms.saturating_sub(t) > max_gap_ms || t > now_ms + 5_000 {
            return Self::default();
        }
        let Some(hist) = value.get("hist") else {
            return Self::default();
        };
        let series = |key: &str| -> VecDeque<f64> {
            let mut out: VecDeque<f64> = hist
                .get(key)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_f64).filter(|v| v.is_finite()).collect())
                .unwrap_or_default();
            while out.len() > HISTORY {
                out.pop_front();
            }
            out
        };
        Self { cpu: series("cpu"), mem: series("mem"), gpu: series("gpu"), rx: series("rx"), tx: series("tx") }
    }
}

/// Inserts `value` under `key` unless it is null, keeping the snapshot small.
pub fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    map.insert(key.to_string(), value.unwrap_or(Value::Null));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_keeps_three_decimals_and_survives_nan() {
        assert_eq!(r3(0.123_456), 0.123);
        assert_eq!(r3(f64::NAN), 0.0);
        assert_eq!(r1(55.55), 55.6);
    }

    #[test]
    fn history_is_capped() {
        let mut s = VecDeque::new();
        for i in 0..(HISTORY + 10) {
            Histories::push(&mut s, i as f64);
        }
        assert_eq!(s.len(), HISTORY);
        assert_eq!(s.front().copied(), Some(10.0));
    }

    #[test]
    fn a_recent_snapshot_resumes_its_charts() {
        let text = r#"{"t":10000,"hist":{"cpu":[0.1,0.2],"mem":[0.5],"gpu":[],"rx":[100],"tx":[5]}}"#;
        let h = Histories::resume(text, 12_000, 30_000);
        assert_eq!(h.cpu, VecDeque::from(vec![0.1, 0.2]));
        assert_eq!(h.rx, VecDeque::from(vec![100.0]));
    }

    #[test]
    fn an_old_or_broken_snapshot_starts_fresh() {
        let text = r#"{"t":10000,"hist":{"cpu":[0.1]}}"#;
        assert!(Histories::resume(text, 100_000, 30_000).cpu.is_empty());
        assert!(Histories::resume("{not json", 10_000, 30_000).cpu.is_empty());
        assert!(Histories::resume(r#"{"hist":{"cpu":[1]}}"#, 10_000, 30_000).cpu.is_empty());
    }

    #[test]
    fn history_round_trips_through_json() {
        let mut h = Histories::default();
        Histories::push(&mut h.cpu, 0.123_456);
        Histories::push(&mut h.rx, 1234.6);
        let text = json!({ "t": 5000, "hist": h.to_json() }).to_string();
        let back = Histories::resume(&text, 5000, 1000);
        assert_eq!(back.cpu, VecDeque::from(vec![0.123]));
        assert_eq!(back.rx, VecDeque::from(vec![1235.0]));
    }
}
