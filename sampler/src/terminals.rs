//! Which shell pid belongs to which Herdr terminal, from herdr-core (`hc`).
//!
//! Runs on its own thread: a core that is slow to answer must never stall the
//! one-second sampling loop. `hc ls` names the live terminals; `hc get` is asked
//! once per terminal for its shell pid, and again only when that pid has gone
//! (a lost terminal comes back with a new shell at the same address).

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

/// Addresses on this computer that are live, from `hc ls --json`.
///
/// Remote terminals (`machine/t3`) are skipped: their processes are on another machine.
pub fn parse_ls(json: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let list = match &value {
        serde_json::Value::Array(items) => items.as_slice(),
        serde_json::Value::Object(map) => match map.get("terminals") {
            Some(serde_json::Value::Array(items)) => items.as_slice(),
            _ => &[],
        },
        _ => &[],
    };
    list.iter()
        .filter(|t| t.get("state").and_then(|s| s.as_str()).map_or(true, |s| s == "live"))
        .filter_map(|t| t.get("address")?.as_str())
        .filter(|a| !a.contains('/'))
        .map(str::to_string)
        .collect()
}

/// The shell's pid from `hc get <t> --json`.
pub fn parse_get(json: &str) -> Option<i32> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let pid = value.get("pid")?.as_i64()?;
    (pid > 0 && pid <= i32::MAX as i64).then_some(pid as i32)
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the pid exists and may be signalled.
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) }
}

fn run(hc: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(hc)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Starts the watcher. Each message is the whole current map, address → shell pid.
/// The channel closes if `hc` cannot be run at all, which the sampler reports as
/// "no attribution" rather than as zero load.
pub fn watch(hc: String, every: Duration) -> Receiver<HashMap<String, i32>> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("terminals".into())
        .spawn(move || {
            let mut pids: HashMap<String, i32> = HashMap::new();
            loop {
                let Some(listing) = run(&hc, &["ls", "--json"]) else {
                    return; // no hc here: drop the sender
                };
                let live = parse_ls(&listing);
                pids.retain(|a, pid| live.contains(a) && alive(*pid));
                for address in &live {
                    if pids.contains_key(address) {
                        continue;
                    }
                    if let Some(pid) = run(&hc, &["get", address, "--json"]).as_deref().and_then(parse_get) {
                        pids.insert(address.clone(), pid);
                    }
                }
                if tx.send(pids.clone()).is_err() {
                    return;
                }
                std::thread::sleep(every);
            }
        })
        .expect("spawn terminals thread");
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ls_keeps_live_local_terminals() {
        let json = r#"[
            {"address":"t1","state":"live"},
            {"address":"t2","state":"finished"},
            {"address":"studio/t3","state":"live"},
            {"address":"t4"}
        ]"#;
        assert_eq!(parse_ls(json), vec!["t1", "t4"]);
    }

    #[test]
    fn ls_accepts_an_object_with_a_terminals_list() {
        assert_eq!(parse_ls(r#"{"terminals":[{"address":"t9","state":"live"}]}"#), vec!["t9"]);
    }

    #[test]
    fn ls_that_is_not_json_lists_nothing() {
        assert!(parse_ls("hc: core is not running").is_empty());
    }

    #[test]
    fn get_reads_the_shell_pid_not_the_foreground_one() {
        let json = r#"{"address":"t45","pid":3762,"foreground":{"pid":4302,"name":"node"}}"#;
        assert_eq!(parse_get(json), Some(3762));
        assert_eq!(parse_get(r#"{"pid":0}"#), None);
        assert_eq!(parse_get("{}"), None);
    }
}
