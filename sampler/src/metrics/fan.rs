//! Fan speed from AppleSMC.
//!
//! `FNum` holds the fan count, and each fan `i` publishes `F<i>Ac` (actual
//! RPM), `F<i>Mn` (minimum) and `F<i>Mx` (maximum). Percentage is reported
//! against the maximum rather than against the min-to-max span, because that is
//! what the tools people compare this against show: a fan idling at its minimum
//! reads as a low percentage rather than as zero, which matches the intuition
//! that "0%" means stopped.
//!
//! Machines with no fans — every Apple Silicon laptop below the Pro, and the
//! Air at any tier — report a count of zero, which is a reading of "none"
//! rather than a failure.

use crate::metrics::Sample;

/// One fan's current state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fan {
    pub rpm: f32,
    /// Speed as a fraction of this fan's maximum, in `0.0..=1.0`.
    pub fraction: f32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FanSample {
    pub fans: Vec<Fan>,
}

impl FanSample {
    /// The fan working hardest, which is the one worth showing when there is
    /// room for a single number.
    pub fn fastest(&self) -> Option<Fan> {
        self.fans
            .iter()
            .copied()
            .fold(None, |acc: Option<Fan>, fan| match acc {
                Some(best) if best.fraction >= fan.fraction => Some(best),
                _ => Some(fan),
            })
    }
}

impl Sample {
    /// Convenience for the format-string lookup, which asks for this often.
    pub fn fastest_fan(&self) -> Option<Fan> {
        self.fan.fastest()
    }
}

#[cfg(target_os = "macos")]
pub struct FanCollector {
    smc: crate::metrics::smc::Smc,
    /// The `F<i>Ac` key to read each tick, paired with that fan's maximum.
    ///
    /// `F<i>Mx` is a property of the fan, not a reading: it is the same number
    /// for the life of the machine. Re-reading it every sample doubled this
    /// collector's SMC traffic to re-learn a constant, so it is resolved once
    /// here alongside the fan count.
    fans: Vec<(String, f32)>,
}

#[cfg(target_os = "macos")]
impl FanCollector {
    pub fn new() -> Option<Self> {
        let smc = crate::metrics::smc::Smc::open()?;
        // A machine with no fans is not a failure; it just never has a reading.
        let count = smc.read("FNum").unwrap_or(0.0).clamp(0.0, 16.0) as u32;
        let fans = (0..count)
            .filter_map(|index| {
                let actual = format!("F{index}Ac");
                // A fan that answers neither its speed nor a usable maximum has
                // no honest percentage to report, so it is dropped outright.
                smc.read(&actual)?;
                let maximum = smc.read(&format!("F{index}Mx")).filter(|m| *m > 0.0)?;
                Some((actual, maximum))
            })
            .collect();
        Some(Self { smc, fans })
    }

    pub fn sample(&mut self) -> FanSample {
        let fans = self
            .fans
            .iter()
            .filter_map(|(actual, maximum)| {
                let rpm = self.smc.read(actual)?;
                Some(Fan {
                    rpm,
                    fraction: (rpm / maximum).clamp(0.0, 1.0),
                })
            })
            .collect();
        FanSample { fans }
    }
}

#[cfg(not(target_os = "macos"))]
pub struct FanCollector;

#[cfg(not(target_os = "macos"))]
impl FanCollector {
    /// hwmon exposes fans too, but as a per-chip zoo with no maximum to scale
    /// against, so there is nothing honest to report as a percentage.
    pub fn new() -> Option<Self> {
        None
    }

    pub fn sample(&mut self) -> FanSample {
        FanSample::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fastest_is_the_hardest_working_fan_not_the_loudest_rpm() {
        // Two fans with different maxima: the one at a higher fraction of its
        // own ceiling is the one under pressure, even at fewer RPM.
        let sample = FanSample {
            fans: vec![
                Fan {
                    rpm: 4000.0,
                    fraction: 0.45,
                },
                Fan {
                    rpm: 3200.0,
                    fraction: 0.80,
                },
            ],
        };
        assert_eq!(sample.fastest().map(|f| f.rpm), Some(3200.0));
        assert_eq!(FanSample::default().fastest(), None);
    }

    #[test]
    fn a_fanless_machine_reports_nothing_rather_than_zero() {
        // A Mac with no fans must render no fan item at all; 0% would read as
        // "fans stopped", which is a different and alarming claim.
        assert_eq!(FanSample::default().fastest(), None);
    }
}
