//! herdr-stats-sampler: one small JSON snapshot of this machine, every second.
//!
//! The herdr-stats mod starts it through Herdr's `exec` and reads the snapshot
//! file; it never talks to Herdr itself. Every copy of the mod may try to start
//! one, so it takes a lock and a second sampler exits at once. It retires on its
//! own: when the program that started it (Herdr) is gone, when it is signalled,
//! when no copy of the mod has checked in for `--idle`, or after `--lifetime`,
//! kept under the ten minutes Herdr allows an `exec`.
//!
//!     herdr-stats-sampler --dir <folder> [--interval 1000] [--lifetime 540000] [--idle 30000]
//!     herdr-stats-sampler --once          one snapshot on stdout
//!
//! In `<folder>`: `snapshot.json` (replaced atomically each tick),
//! `sampler.lock` (the running sampler's pid), `alive`, which every copy of the
//! mod touches every 10 s, and `want-detail`, which the dashboard touches while
//! it is open to ask for the per-process list.

#[allow(dead_code)] // shared with herdr-stats, whose doctor uses the diagnostics
mod metrics;
mod snapshot;
mod terminals;

use metrics::{
    Cadence, CpuCollector, CpuSample, DiskCollector, DiskSample, FanCollector, FanSample, GpuCollector,
    MemCollector, NetCollector, ProcCollector, TempCollector, TempSample, TopCollector,
};
use serde_json::{json, Map, Value};
use snapshot::{put, r1, r3, Histories};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static STOP: AtomicBool = AtomicBool::new(false);

const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Args {
    dir: Option<PathBuf>,
    interval: Duration,
    lifetime: Duration,
    idle: Duration,
    once: bool,
    terminals: bool,
    hc: String,
}

fn parse_args() -> Result<Args, String> {
    parse_args_from(std::env::args().skip(1).collect())
}

fn parse_args_from(argv: Vec<String>) -> Result<Args, String> {
    let mut args = Args {
        dir: None,
        interval: Duration::from_millis(1000),
        lifetime: Duration::from_millis(540_000),
        idle: Duration::from_millis(30_000),
        once: false,
        terminals: true,
        hc: "hc".into(),
    };
    let mut it = argv.into_iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--dir" => args.dir = Some(PathBuf::from(value("--dir")?)),
            "--interval" => {
                let ms: u64 = value("--interval")?.parse().map_err(|_| "--interval is milliseconds")?;
                args.interval = Duration::from_millis(ms.clamp(250, 60_000));
            }
            "--idle" => {
                let ms: u64 = value("--idle")?.parse().map_err(|_| "--idle is milliseconds (0: never)")?;
                args.idle = Duration::from_millis(ms);
            }
            "--lifetime" => {
                let ms: u64 = value("--lifetime")?.parse().map_err(|_| "--lifetime is milliseconds")?;
                args.lifetime = Duration::from_millis(ms.max(1_000));
            }
            "--hc" => args.hc = value("--hc")?,
            "--no-terminals" => args.terminals = false,
            "--once" => args.once = true,
            "--version" | "-V" => {
                println!("herdr-stats-sampler {VERSION}");
                std::process::exit(0);
            }
            "--help" | "-h" => {
                println!("herdr-stats-sampler --dir <folder> [--interval ms] [--lifetime ms] [--idle ms] [--hc path] [--no-terminals]\nherdr-stats-sampler --once");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    if !args.once && args.dir.is_none() {
        return Err("--dir is required (or --once)".into());
    }
    Ok(args)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

extern "C" fn on_signal(_: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

fn install_signals() {
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(sig, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        }
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}

/// Holds the lock for the life of the process (the fd is never closed).
/// `Ok(false)`: another sampler holds it.
fn take_lock(dir: &Path) -> std::io::Result<bool> {
    use std::os::unix::io::AsRawFd;
    let file = std::fs::OpenOptions::new().create(true).read(true).write(true).truncate(false).open(dir.join("sampler.lock"))?;
    // SAFETY: flock on an fd we own.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Ok(false);
    }
    file.set_len(0)?;
    (&file).write_all(format!("{}\n", std::process::id()).as_bytes())?;
    std::mem::forget(file);
    Ok(true)
}

fn parent_of(pid: i32) -> Option<i32> {
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        // SAFETY: a full-size write initialises the struct.
        let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr() as *mut libc::c_void, size) };
        (n == size).then(|| unsafe { info.assume_init() }.pbi_ppid as i32)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        raw[raw.rfind(')')? + 1..].split_whitespace().nth(1)?.parse().ok()
    }
}

fn gone(pid: i32) -> bool {
    // SAFETY: signal 0 checks existence only.
    unsafe { libc::kill(pid, 0) != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) }
}

/// The processes whose end should end this one: the parent, and its parent
/// when the parent is a wrapper (a shell) that could outlive Herdr.
fn lifelines() -> Vec<i32> {
    // SAFETY: getppid cannot fail.
    let parent = unsafe { libc::getppid() };
    let mut out = vec![];
    if parent > 1 {
        out.push(parent);
        if let Some(grand) = parent_of(parent).filter(|&p| p > 1) {
            out.push(grand);
        }
    }
    out
}

/// This machine's name, or `HERDR_STATS_HOST` when set (the README's pictures use it, so
/// they don't show the name of the Mac they were taken on).
fn hostname() -> Option<String> {
    if let Some(name) = std::env::var("HERDR_STATS_HOST").ok().filter(|n| !n.is_empty()) {
        return Some(name);
    }
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most buf.len() bytes.
    if unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).into_owned();
    Some(name.trim_end_matches(".local").to_string()).filter(|s| !s.is_empty())
}

fn uptime_secs() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut tv = libc::timeval { tv_sec: 0, tv_usec: 0 };
        let mut size = std::mem::size_of::<libc::timeval>();
        let name = c"kern.boottime";
        // SAFETY: kern.boottime is a struct timeval of exactly this size.
        let ok = unsafe { libc::sysctlbyname(name.as_ptr(), &mut tv as *mut _ as *mut libc::c_void, &mut size, std::ptr::null_mut(), 0) } == 0;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
        ok.then(|| (now - tv.tv_sec as i64).max(0) as u64)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let raw = std::fs::read_to_string("/proc/uptime").ok()?;
        raw.split_whitespace().next()?.parse::<f64>().ok().map(|s| s as u64)
    }
}

fn load_average() -> Option<[f64; 3]> {
    let mut out = [0f64; 3];
    // SAFETY: getloadavg writes at most 3 doubles.
    (unsafe { libc::getloadavg(out.as_mut_ptr(), 3) } == 3).then_some(out)
}

/// Every collector and the state between ticks.
struct Sampler {
    cpu: CpuCollector,
    cpu_sample: CpuSample,
    mem: MemCollector,
    disk: DiskCollector,
    disk_sample: Option<DiskSample>,
    temp: Option<TempCollector>,
    temp_sample: TempSample,
    fan: Option<FanCollector>,
    fan_sample: FanSample,
    gpu: Option<GpuCollector>,
    net: NetCollector,
    procs: ProcCollector,
    top: TopCollector,
    hist: Histories,
    terminals: Option<std::sync::mpsc::Receiver<HashMap<String, i32>>>,
    terminal_pids: Option<HashMap<String, i32>>,
    terms: Option<Value>,
    top_rows: Option<Value>,
    slow: Cadence,
    disk_due: Cadence,
    attribution: Cadence,
    seq: u64,
    host: Option<String>,
    started: u64,
}

impl Sampler {
    fn new(args: &Args, hist: Histories) -> Self {
        let terminals = args.terminals.then(|| terminals::watch(args.hc.clone(), Duration::from_secs(10)));
        let mut s = Self {
            cpu: CpuCollector::new(),
            cpu_sample: CpuSample::default(),
            mem: MemCollector::new(),
            disk: DiskCollector::new(),
            disk_sample: None,
            temp: TempCollector::new(),
            temp_sample: TempSample::default(),
            fan: FanCollector::new(),
            fan_sample: FanSample::default(),
            gpu: GpuCollector::new(),
            net: NetCollector::new(),
            procs: ProcCollector::new(),
            top: TopCollector::new(),
            hist,
            terminals,
            terminal_pids: None,
            terms: None,
            top_rows: None,
            slow: Cadence::new(Duration::from_millis(2000)),
            disk_due: Cadence::new(Duration::from_secs(10)),
            attribution: Cadence::new(Duration::from_millis(2000)),
            seq: 0,
            host: hostname(),
            started: now_ms(),
        };
        // Seed every rate counter so the first published tick is a real reading.
        let _ = s.cpu.sample(&mut s.cpu_sample);
        s.net.sample();
        s
    }

    fn tick(&mut self, interval: Duration, want_detail: bool) -> Value {
        let now = Instant::now();
        self.seq += 1;
        let _ = self.cpu.sample(&mut self.cpu_sample);
        let mem = self.mem.sample().ok();
        let net = self.net.sample();
        let gpu = self.gpu.as_mut().and_then(|g| g.sample());
        if self.slow.due(now) {
            if let Some(t) = self.temp.as_mut() {
                self.temp_sample = t.sample();
            }
            if let Some(f) = self.fan.as_mut() {
                self.fan_sample = f.sample();
            }
        }
        if self.disk_due.due(now) {
            self.disk_sample = self.disk.sample().ok().or(self.disk_sample);
        }
        if let Some(rx) = &self.terminals {
            loop {
                match rx.try_recv() {
                    Ok(map) => self.terminal_pids = Some(map),
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        self.terminals = None;
                        self.terminal_pids = None;
                        self.terms = None;
                        break;
                    }
                }
            }
        }
        if self.attribution.due(now) {
            if let Some(pids) = &self.terminal_pids {
                let mut rows = self.procs.sample(pids.iter().map(|(a, p)| (a.as_str(), *p)));
                rows.sort_by(|a, b| b.1.cpu.total_cmp(&a.1.cpu).then(b.1.rss.cmp(&a.1.rss)));
                self.terms = Some(Value::from(
                    rows.into_iter()
                        .map(|(a, u)| json!({ "a": a, "cpu": r3(u.cpu as f64), "rss": u.rss, "n": u.processes, "top": u.busiest }))
                        .collect::<Vec<_>>(),
                ));
            }
            self.top_rows = want_detail.then(|| {
                Value::from(
                    self.top
                        .sample(12)
                        .into_iter()
                        .map(|p| json!({ "pid": p.pid, "name": p.name, "cpu": r3(p.cpu as f64), "rss": p.rss }))
                        .collect::<Vec<_>>(),
                )
            });
        }

        let c = &self.cpu_sample;
        Histories::push(&mut self.hist.cpu, c.total as f64);
        if let Some(m) = &mem {
            Histories::push(&mut self.hist.mem, m.used_fraction() as f64);
        }
        if let Some(g) = &gpu {
            Histories::push(&mut self.hist.gpu, g.busy as f64);
        }
        Histories::push(&mut self.hist.rx, net.rx);
        Histories::push(&mut self.hist.tx, net.tx);

        let mut root = Map::new();
        root.insert("v".into(), json!(1));
        root.insert("t".into(), json!(now_ms()));
        root.insert("seq".into(), json!(self.seq));
        root.insert("interval".into(), json!(interval.as_millis() as u64));
        root.insert("pid".into(), json!(std::process::id()));
        root.insert("version".into(), json!(VERSION));
        root.insert("started".into(), json!(self.started));
        root.insert("os".into(), json!(std::env::consts::OS));
        put(&mut root, "host", self.host.clone().map(Value::from));
        put(&mut root, "uptime", uptime_secs().map(Value::from));
        put(&mut root, "load", load_average().map(|l| json!([r3(l[0]), r3(l[1]), r3(l[2])])));
        root.insert(
            "cpu".into(),
            json!({
                "total": r3(c.total as f64),
                "max": r3(c.busiest_core().unwrap_or(0.0) as f64),
                "p": c.performance.map(|v| r3(v as f64)),
                "e": c.efficiency.map(|v| r3(v as f64)),
                "pcores": c.performance_cores,
                "cores": c.cores.iter().map(|k| r3(k.busy as f64)).collect::<Vec<_>>(),
            }),
        );
        put(
            &mut root,
            "mem",
            mem.map(|m| {
                json!({ "total": m.total, "used": m.used, "wired": m.wired, "compressed": m.compressed,
                        "swap": m.swap_used, "pressure": m.pressure.map(|p| r3(p as f64)) })
            }),
        );
        put(&mut root, "disk", self.disk_sample.map(|d| json!({ "total": d.total, "used": d.used, "available": d.available })));
        put(&mut root, "gpu", gpu.map(|g| json!({ "busy": r3(g.busy as f64), "memory": g.memory })));
        root.insert("net".into(), json!({ "rx": net.rx.round(), "tx": net.tx.round() }));
        let t = &self.temp_sample;
        let deg = |v: Option<f32>| v.map(|x| r1(x as f64));
        root.insert(
            "temp".into(),
            json!({ "cpu": deg(t.cpu), "cpu_avg": deg(t.cpu_avg), "gpu": deg(t.gpu), "soc": deg(t.soc),
                    "ssd": deg(t.ssd), "battery": deg(t.battery) }),
        );
        root.insert(
            "fans".into(),
            Value::from(
                self.fan_sample.fans.iter().map(|f| json!({ "rpm": f.rpm.round(), "fraction": r3(f.fraction as f64) })).collect::<Vec<_>>(),
            ),
        );
        root.insert("hist".into(), self.hist.to_json());
        put(&mut root, "terms", self.terms.clone());
        put(&mut root, "top", self.top_rows.clone());
        Value::Object(root)
    }
}

fn bench() {
    fn cpu_us() -> f64 {
        let mut u = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // SAFETY: getrusage fills the struct for this process.
        unsafe { libc::getrusage(libc::RUSAGE_SELF, u.as_mut_ptr()) };
        let u = unsafe { u.assume_init() };
        let tv = |t: libc::timeval| t.tv_sec as f64 * 1e6 + t.tv_usec as f64;
        tv(u.ru_utime) + tv(u.ru_stime)
    }
    // Wall time and this process's CPU time per call: a sensor read can wait on
    // another process without costing this one anything.
    fn time<T>(name: &str, n: u32, mut f: impl FnMut() -> T) {
        let start = Instant::now();
        let cpu = cpu_us();
        for _ in 0..n {
            std::hint::black_box(f());
        }
        let wall = start.elapsed().as_secs_f64() * 1e6 / n as f64;
        println!("{name:>14}: {wall:>9.1} µs wall {:>9.1} µs cpu", (cpu_us() - cpu) / n as f64);
    }
    let mut cpu = CpuCollector::new();
    let mut cs = CpuSample::default();
    time("cpu", 200, || cpu.sample(&mut cs));
    let mut mem = MemCollector::new();
    time("mem", 200, || mem.sample());
    let mut net = NetCollector::new();
    time("net", 200, || net.sample());
    if let Some(mut gpu) = GpuCollector::new() {
        time("gpu", 200, || gpu.sample());
    }
    if let Some(mut temp) = TempCollector::new() {
        time("temp", 50, || temp.sample());
    }
    if let Some(mut fan) = FanCollector::new() {
        time("fan", 50, || fan.sample());
    }
    let mut disk = DiskCollector::new();
    time("disk", 50, || disk.sample());
    time("uptime+load", 200, || (uptime_secs(), load_average()));
    let mut procs = ProcCollector::new();
    let me = std::process::id() as i32;
    time("proc tree", 100, || procs.sample([("t1", me)]));
    let mut top = TopCollector::new();
    time("top", 10, || top.sample(12));
    let args = Args { dir: None, interval: Duration::from_secs(1), lifetime: Duration::from_secs(1), idle: Duration::ZERO, once: true, terminals: false, hc: "hc".into() };
    let mut s = Sampler::new(&args, Histories::default());
    for _ in 0..180 {
        s.tick(Duration::from_secs(1), false);
    }
    time("tick (full)", 50, || s.tick(Duration::from_secs(1), false));
    let snap = s.tick(Duration::from_secs(1), false);
    time("serialize", 200, || snap.to_string());
}

fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Whether `<dir>/<name>` was touched in the last `within`.
fn touched(dir: &Path, name: &str, within: Duration) -> bool {
    std::fs::metadata(dir.join(name))
        .and_then(|m| m.modified())
        .ok()
        .map(|t| SystemTime::now().duration_since(t).unwrap_or(Duration::ZERO))
        .is_some_and(|age| age < within)
}

/// Whether the dashboard asked for detail in the last 15 seconds.
fn wants_detail(dir: &Path) -> bool {
    touched(dir, "want-detail", Duration::from_secs(15))
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("herdr-stats-sampler: {e}");
            std::process::exit(2);
        }
    };

    // Not in --help: what each collector costs, for whoever tunes the cadences.
    if std::env::var_os("HERDR_STATS_BENCH").is_some() {
        bench();
        return;
    }

    if args.once {
        let mut sampler = Sampler::new(&Args { terminals: false, ..args }, Histories::default());
        sampler.top.sample(0); // a baseline, so the one list printed has CPU in it
        std::thread::sleep(Duration::from_millis(500));
        let snap = sampler.tick(Duration::from_millis(500), true);
        println!("{}", serde_json::to_string_pretty(&snap).unwrap_or_default());
        return;
    }

    let dir = args.dir.clone().expect("checked in parse_args");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("herdr-stats-sampler: cannot create {}: {e}", dir.display());
        std::process::exit(1);
    }
    match take_lock(&dir) {
        Ok(true) => {}
        Ok(false) => {
            println!("running");
            return;
        }
        Err(e) => {
            eprintln!("herdr-stats-sampler: cannot lock {}: {e}", dir.display());
            std::process::exit(1);
        }
    }
    install_signals();
    let lifelines = lifelines();
    let path = dir.join("snapshot.json");
    let hist = std::fs::read_to_string(&path).map(|t| Histories::resume(&t, now_ms(), 60_000)).unwrap_or_default();
    let mut sampler = Sampler::new(&args, hist);

    let start = Instant::now();
    let mut next = start + args.interval;
    loop {
        let pause = next.saturating_duration_since(Instant::now());
        // Sleep in short steps so a signal or Herdr quitting ends us promptly.
        let mut slept = Duration::ZERO;
        while slept < pause && !STOP.load(Ordering::SeqCst) {
            let step = (pause - slept).min(Duration::from_millis(250));
            std::thread::sleep(step);
            slept += step;
        }
        if STOP.load(Ordering::SeqCst) || lifelines.iter().any(|&p| gone(p)) || unsafe { libc::getppid() } == 1 {
            break;
        }
        let snap = sampler.tick(args.interval, wants_detail(&dir));
        if let Err(e) = write_atomically(&path, &snap.to_string()) {
            eprintln!("herdr-stats-sampler: cannot write {}: {e}", path.display());
        }
        if start.elapsed() >= args.lifetime {
            break;
        }
        // Nobody showing the stats: every copy touches `alive` every 10 s, and
        // closing one can't wait for a kill (Herdr gives close() 250 ms).
        if !args.idle.is_zero() && start.elapsed() >= args.idle && !touched(&dir, "alive", args.idle) {
            break;
        }
        next += args.interval;
        // Woken late (the machine slept): start the schedule again from now.
        if next < Instant::now() {
            next = Instant::now() + args.interval;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_counts_as_touched_only_within_the_window() {
        let dir = std::env::temp_dir().join(format!("herdr-stats-touch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!touched(&dir, "alive", Duration::from_secs(30)), "missing: nobody checked in");
        std::fs::write(dir.join("alive"), "").unwrap();
        assert!(touched(&dir, "alive", Duration::from_secs(30)));
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options().write(true).open(dir.join("alive")).unwrap().set_modified(old).unwrap();
        assert!(!touched(&dir, "alive", Duration::from_secs(30)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn idle_is_milliseconds_and_zero_turns_it_off() {
        let parse = |v: &[&str]| {
            let saved: Vec<String> = v.iter().map(|s| s.to_string()).collect();
            parse_args_from(saved)
        };
        assert_eq!(parse(&["--once", "--idle", "0"]).unwrap().idle, Duration::ZERO);
        assert_eq!(parse(&["--once"]).unwrap().idle, Duration::from_secs(30));
    }
}
