//! Local device detection.
//!
//! Two consumers, deliberately separated:
//!   * `DeviceProfile` — *what this machine is*. Pure description, no policy.
//!   * `backends::recommend` — *what to do about it*. Pure policy, no I/O.
//!
//! The profile is serde-serializable and carries a `schema_version` plus a
//! privacy-preserving `fingerprint` so a future benchmark-sharing service can
//! group results by device class without the payload ever carrying a hostname,
//! serial number or user name.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DEVICE_PROFILE_SCHEMA: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Unknown,
}

impl GpuVendor {
    /// PCI SIG vendor IDs.
    pub fn from_pci(vendor_id: u16) -> Self {
        match vendor_id {
            0x10de | 0x12d2 => Self::Nvidia,
            0x1002 | 0x1022 => Self::Amd,
            0x8086 | 0x8087 => Self::Intel,
            0x106b => Self::Apple,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Nvidia => "nvidia",
            Self::Amd => "amd",
            Self::Intel => "intel",
            Self::Apple => "apple",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct GpuDevice {
    pub vendor: GpuVendor,
    pub name: String,
    pub vram_mb: Option<u64>,
    pub driver: Option<String>,
    /// Lower-case `vendor:device`, e.g. `1002:7551`.
    pub pci_id: Option<String>,
    /// Integrated parts share system memory and are a poor fit for the
    /// vendor-specific compute runtimes even when the vendor matches.
    pub integrated: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CpuInfo {
    pub name: String,
    pub logical_cores: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DeviceProfile {
    pub schema_version: u32,
    pub os: String,
    pub arch: String,
    pub cpu: CpuInfo,
    pub gpus: Vec<GpuDevice>,
    /// How the GPU list was obtained, so a bug report can tell "no GPU" from
    /// "could not look".
    pub detection: String,
    pub fingerprint: String,
}

impl DeviceProfile {
    /// The best discrete GPU, falling back to an integrated one.
    pub fn primary_gpu(&self) -> Option<&GpuDevice> {
        self.gpus
            .iter()
            .filter(|gpu| !gpu.integrated)
            .max_by_key(|gpu| gpu.vram_mb.unwrap_or(0))
            .or_else(|| self.gpus.first())
    }

    pub fn has_vendor(&self, vendor: GpuVendor) -> bool {
        self.gpus.iter().any(|gpu| gpu.vendor == vendor)
    }

    pub fn has_discrete(&self, vendor: GpuVendor) -> bool {
        self.gpus
            .iter()
            .any(|gpu| gpu.vendor == vendor && !gpu.integrated)
    }
}

/// Stable across runs on the same hardware, identical across machines with the
/// same parts, and reveals nothing that identifies the owner.
pub fn fingerprint(os: &str, arch: &str, cpu: &CpuInfo, gpus: &[GpuDevice]) -> String {
    let mut parts = vec![
        os.to_string(),
        arch.to_string(),
        normalize(&cpu.name),
        cpu.logical_cores.to_string(),
    ];
    let mut gpu_parts: Vec<String> = gpus
        .iter()
        .map(|gpu| {
            format!(
                "{}|{}|{}",
                gpu.vendor.as_str(),
                normalize(&gpu.name),
                // Bucket VRAM so a 100 MB reporting difference does not split
                // otherwise-identical devices into separate classes.
                gpu.vram_mb.map(|mb| mb / 1024).unwrap_or(0)
            )
        })
        .collect();
    gpu_parts.sort();
    parts.extend(gpu_parts);
    let mut hasher = Sha256::new();
    hasher.update(parts.join("\n").as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn logical_cores() -> u32 {
    std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(0)
}

pub fn detect() -> DeviceProfile {
    let (gpus, detection) = detect_gpus();
    let cpu = CpuInfo {
        name: detect_cpu_name(),
        logical_cores: logical_cores(),
    };
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let fingerprint = fingerprint(&os, &arch, &cpu, &gpus);
    DeviceProfile {
        schema_version: DEVICE_PROFILE_SCHEMA,
        os,
        arch,
        cpu,
        gpus,
        detection,
        fingerprint,
    }
}

#[cfg(windows)]
mod windows_detect {
    use super::{GpuDevice, GpuVendor};
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_DWORD, REG_QWORD, REG_SZ,
    };

    /// The display adapter setup class.
    const DISPLAY_CLASS: &str =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    fn wide(value: &str) -> Vec<u16> {
        OsString::from(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn open(parent: HKEY, path: &str) -> Option<Key> {
        let mut handle: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                parent,
                wide(path).as_ptr(),
                0,
                KEY_READ,
                &mut handle as *mut HKEY,
            )
        };
        (status == ERROR_SUCCESS && !handle.is_null()).then_some(Key(handle))
    }

    fn read_raw(key: &Key, name: &str) -> Option<(u32, Vec<u8>)> {
        let name = wide(name);
        let mut kind: u32 = 0;
        let mut size: u32 = 0;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS || size == 0 || size > 64 * 1024 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buffer.as_mut_ptr(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then(|| {
            buffer.truncate(size as usize);
            (kind, buffer)
        })
    }

    fn read_string(key: &Key, name: &str) -> Option<String> {
        let (kind, bytes) = read_raw(key, name)?;
        if kind != REG_SZ {
            return None;
        }
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        let value = OsString::from_wide(&units).to_string_lossy().into_owned();
        (!value.trim().is_empty()).then_some(value)
    }

    fn read_u64(key: &Key, name: &str) -> Option<u64> {
        let (kind, bytes) = read_raw(key, name)?;
        match kind {
            REG_QWORD if bytes.len() >= 8 => {
                Some(u64::from_le_bytes(bytes[..8].try_into().ok()?))
            }
            REG_DWORD if bytes.len() >= 4 => {
                Some(u32::from_le_bytes(bytes[..4].try_into().ok()?) as u64)
            }
            _ => None,
        }
    }

    /// `PCI\VEN_1002&DEV_7551&...` -> (0x1002, "1002:7551")
    fn parse_pci(matching_id: &str) -> Option<(u16, String)> {
        let lower = matching_id.to_lowercase();
        let vendor_hex = lower.split("ven_").nth(1)?.get(..4)?.to_string();
        let vendor = u16::from_str_radix(&vendor_hex, 16).ok()?;
        let device_hex = lower
            .split("dev_")
            .nth(1)
            .and_then(|rest| rest.get(..4))
            .unwrap_or("0000")
            .to_string();
        Some((vendor, format!("{vendor_hex}:{device_hex}")))
    }

    pub fn gpus() -> Option<Vec<GpuDevice>> {
        let class = open(HKEY_LOCAL_MACHINE, DISPLAY_CLASS)?;
        let mut found = Vec::new();
        for index in 0..64u32 {
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    class.0,
                    index,
                    name.as_mut_ptr(),
                    &mut length,
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            let subkey = String::from_utf16_lossy(&name[..length as usize]);
            // Adapter instances are the four-digit subkeys; skip Configuration etc.
            if subkey.len() != 4 || !subkey.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Some(adapter) = open(class.0, &subkey) else {
                continue;
            };
            let Some(description) = read_string(&adapter, "DriverDesc") else {
                continue;
            };
            let matching = read_string(&adapter, "MatchingDeviceId").unwrap_or_default();
            let (vendor_id, pci_id) = match parse_pci(&matching) {
                Some((vendor, pci)) => (vendor, Some(pci)),
                None => (0, None),
            };
            let vram_mb = read_u64(&adapter, "HardwareInformation.qwMemorySize")
                .filter(|bytes| *bytes > 0)
                .map(|bytes| bytes / (1024 * 1024));
            found.push(GpuDevice {
                vendor: GpuVendor::from_pci(vendor_id),
                integrated: super::looks_integrated(&description, vram_mb),
                name: description,
                vram_mb,
                driver: read_string(&adapter, "DriverVersion"),
                pci_id,
            });
        }
        Some(found)
    }

    pub fn cpu_name() -> Option<String> {
        let key = open(
            HKEY_LOCAL_MACHINE,
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        )?;
        read_string(&key, "ProcessorNameString").map(|value| value.trim().to_string())
    }
}

/// Integrated parts either say so in the name or expose a token carve-out of
/// shared memory rather than real VRAM.
fn looks_integrated(name: &str, vram_mb: Option<u64>) -> bool {
    let lower = name.to_lowercase();
    if lower.contains("integrated")
        || lower.contains("igpu")
        || lower.contains(" uhd ")
        || lower.ends_with(" uhd graphics")
        || lower.contains("iris")
        || lower.contains("vega ") && lower.contains("mobile")
    {
        return true;
    }
    // A discrete accelerator worth targeting has its own multi-gigabyte pool.
    matches!(vram_mb, Some(mb) if mb < 1024)
}

#[cfg(target_os = "linux")]
fn detect_gpus() -> (Vec<GpuDevice>, String) {
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return (Vec::new(), "unavailable".into());
    };
    let mut gpus = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let device = entry.path().join("device");
        let read = |file: &str| {
            std::fs::read_to_string(device.join(file))
                .ok()
                .map(|value| value.trim().to_string())
        };
        let Some(vendor_raw) = read("vendor") else {
            continue;
        };
        let vendor_id = u16::from_str_radix(vendor_raw.trim_start_matches("0x"), 16).unwrap_or(0);
        let device_hex = read("device")
            .unwrap_or_default()
            .trim_start_matches("0x")
            .to_string();
        let vram_mb = read("mem_info_vram_total")
            .and_then(|value| value.parse::<u64>().ok())
            .map(|bytes| bytes / (1024 * 1024));
        let label = read("product_name").unwrap_or_else(|| format!("PCI {vendor_raw}"));
        gpus.push(GpuDevice {
            vendor: GpuVendor::from_pci(vendor_id),
            integrated: looks_integrated(&label, vram_mb),
            name: label,
            vram_mb,
            driver: None,
            pci_id: Some(format!("{:04x}:{device_hex}", vendor_id)),
        });
    }
    (gpus, "linux-sysfs".into())
}

#[cfg(target_os = "macos")]
fn detect_gpus() -> (Vec<GpuDevice>, String) {
    // Apple silicon always exposes a Metal GPU sharing system memory; Intel
    // Macs are not a llama.cpp GPU catalog target.
    if std::env::consts::ARCH == "aarch64" {
        (
            vec![GpuDevice {
                vendor: GpuVendor::Apple,
                name: "Apple GPU".into(),
                vram_mb: None,
                driver: None,
                pci_id: None,
                integrated: true,
            }],
            "macos-arch".into(),
        )
    } else {
        (Vec::new(), "macos-arch".into())
    }
}

#[cfg(windows)]
fn detect_gpus() -> (Vec<GpuDevice>, String) {
    match windows_detect::gpus() {
        Some(gpus) => (gpus, "windows-registry".into()),
        None => (Vec::new(), "unavailable".into()),
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn detect_gpus() -> (Vec<GpuDevice>, String) {
    (Vec::new(), "unsupported-platform".into())
}

fn detect_cpu_name() -> String {
    #[cfg(windows)]
    if let Some(name) = windows_detect::cpu_name() {
        return name;
    }
    #[cfg(target_os = "linux")]
    if let Ok(info) = std::fs::read_to_string("/proc/cpuinfo") {
        if let Some(line) = info.lines().find(|line| line.starts_with("model name")) {
            if let Some(value) = line.split(':').nth(1) {
                return value.trim().to_string();
            }
        }
    }
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(vendor: GpuVendor, name: &str, vram_mb: Option<u64>, integrated: bool) -> GpuDevice {
        GpuDevice {
            vendor,
            name: name.into(),
            vram_mb,
            driver: None,
            pci_id: None,
            integrated,
        }
    }

    #[test]
    fn pci_ids_map_to_known_vendors() {
        assert_eq!(GpuVendor::from_pci(0x10de), GpuVendor::Nvidia);
        assert_eq!(GpuVendor::from_pci(0x1002), GpuVendor::Amd);
        assert_eq!(GpuVendor::from_pci(0x8086), GpuVendor::Intel);
        assert_eq!(GpuVendor::from_pci(0x1234), GpuVendor::Unknown);
    }

    #[test]
    fn small_memory_pools_and_named_parts_read_as_integrated() {
        assert!(looks_integrated("AMD Radeon(TM) Graphics", Some(512)));
        assert!(looks_integrated("Intel(R) Iris(R) Xe Graphics", Some(2048)));
        assert!(!looks_integrated("AMD Radeon AI PRO R9700", Some(32623)));
        assert!(!looks_integrated("NVIDIA GeForce RTX 4090", Some(24564)));
    }

    #[test]
    fn primary_gpu_prefers_the_largest_discrete_card() {
        let profile = DeviceProfile {
            schema_version: DEVICE_PROFILE_SCHEMA,
            os: "windows".into(),
            arch: "x86_64".into(),
            cpu: CpuInfo {
                name: "CPU".into(),
                logical_cores: 8,
            },
            gpus: vec![
                gpu(GpuVendor::Amd, "Radeon Graphics", Some(512), true),
                gpu(GpuVendor::Amd, "Radeon AI PRO R9700", Some(32623), false),
            ],
            detection: "test".into(),
            fingerprint: String::new(),
        };
        assert_eq!(profile.primary_gpu().map(|gpu| gpu.name.as_str()), Some("Radeon AI PRO R9700"));
        assert!(profile.has_discrete(GpuVendor::Amd));
        assert!(!profile.has_vendor(GpuVendor::Nvidia));
    }

    #[test]
    fn fingerprint_is_stable_order_independent_and_hardware_sensitive() {
        let cpu = CpuInfo {
            name: "AMD EPYC 4585PX 16-Core Processor".into(),
            logical_cores: 32,
        };
        let a = gpu(GpuVendor::Amd, "Radeon AI PRO R9700", Some(32623), false);
        let b = gpu(GpuVendor::Amd, "Radeon Graphics", Some(512), true);

        let one = fingerprint("windows", "x86_64", &cpu, &[a.clone(), b.clone()]);
        let two = fingerprint("windows", "x86_64", &cpu, &[b.clone(), a.clone()]);
        assert_eq!(one, two, "enumeration order must not change the class");
        assert_eq!(one.len(), 16);

        // Whitespace and case differences describe the same part.
        let noisy = gpu(GpuVendor::Amd, "  Radeon   AI PRO  r9700 ", Some(32623), false);
        assert_eq!(one, fingerprint("windows", "x86_64", &cpu, &[noisy, b.clone()]));

        // Different hardware must land in a different class.
        let other = gpu(GpuVendor::Nvidia, "GeForce RTX 4090", Some(24564), false);
        assert_ne!(one, fingerprint("windows", "x86_64", &cpu, &[other, b]));
        assert_ne!(one, fingerprint("linux", "x86_64", &cpu, &[a]));
    }

    #[test]
    fn fingerprint_carries_no_identifying_material() {
        let cpu = CpuInfo {
            name: "AMD EPYC 4585PX".into(),
            logical_cores: 32,
        };
        let value = fingerprint("windows", "x86_64", &cpu, &[]);
        assert!(value.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
