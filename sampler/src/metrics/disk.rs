//! How full the startup disk is.
//!
//! On macOS `/` is the small, read-only system volume and user files live on
//! `/System/Volumes/Data`; both share one APFS container with the VM, Preview
//! and Recovery volumes and local snapshots. What fills the disk is the
//! container, so "used" is total minus what is still available, the figure
//! Finder, About This Mac and Activity Monitor-style apps show. Counting only
//! the data volume's own blocks reads 58% on a disk that is 75% full and would
//! still read about 60% when nothing is left. Linux uses `/`, the same way.

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DiskSample {
    pub total: u64,
    pub used: u64,
    pub available: u64,
}

impl DiskSample {
    /// How full the disk is: everything not available, over its size.
    pub fn used_fraction(&self) -> f32 {
        if self.total == 0 {
            0.0
        } else {
            (1.0 - self.available as f64 / self.total as f64).clamp(0.0, 1.0) as f32
        }
    }
}

pub struct DiskCollector {
    path: PathBuf,
}

impl DiskCollector {
    pub fn new() -> Self {
        Self {
            path: default_path(),
        }
    }

    pub fn sample(&mut self) -> io::Result<DiskSample> {
        sample_path(&self.path)
    }
}

impl Default for DiskCollector {
    fn default() -> Self {
        Self::new()
    }
}

fn default_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let data = PathBuf::from("/System/Volumes/Data");
        if data.exists() {
            return data;
        }
    }
    PathBuf::from("/")
}

fn sample_path(path: &Path) -> io::Result<DiskSample> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "disk path contains NUL"))?;

    #[cfg(target_os = "macos")]
    {
        // Size and available space are the container's (every APFS volume in
        // it reports the same two). Used is what isn't available.
        let mut attributes = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: 0,
            volattr: libc::ATTR_VOL_INFO
                | libc::ATTR_VOL_SIZE
                | libc::ATTR_VOL_SPACEFREE
                | libc::ATTR_VOL_SPACEAVAIL,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };

        // The kernel packs every attribute on a 4-byte boundary, including
        // u64s: length:u32 followed by size, free and available.
        let mut buffer = [0u8; 28];
        // SAFETY: both pointers reference initialized, correctly-sized storage;
        // getattrlist copies at most `buffer.len()` bytes and retains neither.
        if unsafe {
            libc::getattrlist(
                path.as_ptr(),
                &mut attributes as *mut _ as *mut libc::c_void,
                buffer.as_mut_ptr() as *mut libc::c_void,
                buffer.len(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let returned = u32::from_ne_bytes(buffer[0..4].try_into().expect("fixed slice")) as usize;
        if returned < buffer.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "filesystem returned incomplete volume usage",
            ));
        }
        let value = |offset: usize| {
            u64::from_ne_bytes(
                buffer[offset..offset + 8]
                    .try_into()
                    .expect("fixed attribute slice"),
            )
        };
        let total = value(4);
        let available = value(20).min(total);
        Ok(DiskSample {
            total,
            used: total - available,
            available,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        // SAFETY: `statvfs` initializes the entire output struct on success.
        let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `path` is NUL-terminated and `stats` points to writable storage of
        // the exact type expected by statvfs.
        if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(sample_from_blocks(
            stats.f_frsize,
            stats.f_blocks,
            stats.f_bfree,
            stats.f_bavail,
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn sample_from_blocks(block_size: u64, blocks: u64, _free: u64, available: u64) -> DiskSample {
    // Blocks reserved for root count as used: nobody else can write there.
    let available = available.min(blocks);
    DiskSample {
        total: blocks.saturating_mul(block_size),
        used: (blocks - available).saturating_mul(block_size),
        available: available.saturating_mul(block_size),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_is_whatever_is_not_available() {
        // The M2 Max that showed the bug: 494.4 GB, 123.7 GB available, data volume 286.6 GB.
        let sample = DiskSample {
            total: 494_384_795_648,
            used: 494_384_795_648 - 123_678_658_560,
            available: 123_678_658_560,
        };
        assert!((sample.used_fraction() - 0.75).abs() < 0.005);
    }

    #[test]
    fn the_host_filesystem_can_be_sampled() {
        let sample = DiskCollector::new().sample().expect("sample disk");
        assert!(sample.total > 0);
        assert!(sample.used <= sample.total);
        assert!(sample.available <= sample.total);
        assert_eq!(sample.used + sample.available, sample.total, "used is what isn't available");
    }
}
