// src-tauri/src/runtime.rs
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
#[cfg(unix)]
use std::io;
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};
use uuid::Uuid;

const API_CACHE_TTL: Duration = Duration::from_secs(600);
const MAX_GITHUB_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_PR_INPUT_BYTES: usize = 512;
const MAX_PROBE_OUTPUT: usize = 256 * 1024;
/// A CMake configure or build easily emits megabytes of text. Keep only the
/// end of it: the diagnostic that explains a failure is always the last thing
/// the toolchain printed, never the banner it started with.
const MAX_BUILD_LOG_TAIL: usize = 256 * 1024;
const MAX_BUILD_DETAIL_CHARS: usize = 4096;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// The staged preflight is the very first execution of a just-extracted
/// runtime, so Windows still has to page in and virus-scan 100-250 MB of fresh
/// binaries before `main` runs. That routinely blows past the interactive probe
/// budget; subsequent launches are instant once the scanner has cached them.
const STAGED_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(180);
const PROBE_READER_TIMEOUT: Duration = Duration::from_secs(1);
/// A child that has exited already closed both pipes, so the drain tasks end
/// at once; this budget only covers grandchildren (ninja, cl.exe) that
/// inherited the handles and briefly outlive the CMake driver.
const BUILD_READER_TIMEOUT: Duration = Duration::from_secs(30);
/// After a cancel the process tree is already killed, so waiting for trailing
/// bytes would only delay the error the user asked for.
const CANCEL_READER_TIMEOUT: Duration = Duration::from_secs(2);
/// CMake configure can briefly detect a GPU toolchain or fetch a dependency,
/// which the codebase has already seen take about ten minutes; this is a
/// conservative ceiling for a stuck network probe or antivirus scan, not a
/// target duration.
const CMAKE_CONFIGURE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// A from-source build compiles every requested GGML backend variant, which
/// can run long on a slow machine. This bounds a hung compiler or linker
/// without cutting off a legitimate long build.
const CMAKE_BUILD_TIMEOUT: Duration = Duration::from_secs(3 * 60 * 60);
/// Backends the release catalog can install. Single source of truth for both
/// the downloader and the recommendation policy.
pub const CATALOG_BACKENDS: &[&str] = &["rocm", "vulkan", "cuda", "sycl", "openvino", "cpu"];

type AssetCache = HashMap<String, (Instant, Vec<Asset>)>;
type ErrorCache = HashMap<String, (Instant, String)>;

/// Sidecar file recording what `llama-server --version` reported, so the UI can
/// show a real version instead of only the `bNNNN` CI build tag. GitHub's
/// release metadata carries the build tag alone, so this is the only source.
const VERSION_MANIFEST: &str = "llama-board-runtime.json";
const SOURCE_MANIFEST: &str = "llama-board-runtime-source.json";
const RUNTIME_BUNDLE_MANIFEST: &str = "llama-board-runtime-bundle.json";
const RUNTIME_BUNDLE_FORMAT: u32 = 1;
const LLAMA_REPOSITORY: &str = "ggml-org/llama.cpp";
pub const DFLASH2_PR_BUILD: &str = "pr27342";
/// GitHub releases produced by the PR runtime workflow. The release is
/// deliberately separate from upstream llama.cpp: it contains binaries built
/// from a reviewed PR commit, not source archives.
const PR_ARTIFACT_REPOSITORY: &str = match option_env!("LLAMA_BOARD_PR_ARTIFACT_REPOSITORY") {
    Some(repository) => repository,
    None => "joowon-jang/llama-board",
};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeVersion {
    /// e.g. "0.3.0-dev"
    pub semver: String,
    /// e.g. 10638
    pub build: u64,
    /// e.g. "bf9421646"
    pub commit: String,
}

/// Extra provenance for a runtime built from an upstream pull request.
/// Release archives do not carry this field.
///
/// Every field is recorded as it was at the moment the build started, so a
/// runtime that is still installed months later can still be traced back to
/// the exact tree it came from even after the PR is merged, closed, renamed,
/// force-pushed, or its fork deleted.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct RuntimeSource {
    pub pull_request: u64,
    /// Head repository, e.g. `ggml-org/llama.cpp` or a contributor's fork.
    pub repository: String,
    /// Head branch name at build time. A branch can be force-pushed or
    /// deleted, so this is a label, not an identity - `commit` is the identity.
    #[serde(default)]
    pub head_ref: String,
    /// Login of the account that opened the pull request.
    #[serde(default)]
    pub author: String,
    /// `open`, `closed` or `merged`, as of the build.
    #[serde(default)]
    pub state: String,
    /// True when the head repository is not `ggml-org/llama.cpp`.
    #[serde(default)]
    pub fork: bool,
    /// The full 40-character head commit. This is the only field that
    /// identifies the source tree; everything else can change under it.
    pub commit: String,
    /// SHA-256 of the archive as *this machine downloaded it*, computed here.
    ///
    /// GitHub publishes no digest for a source archive, so this is a record of
    /// what was built - useful for comparing two installs and for audit - and
    /// is explicitly not an independent verification of the download. The
    /// HTTPS request is pinned to `commit`, and `commit_check` records
    /// whether the tree GitHub returned carried it. The local hash is an audit
    /// record, not an independent authenticity proof.
    pub archive_sha256: String,
    /// How the downloaded tree was tied back to `commit`. See
    /// `ArchiveCommitCheck`.
    #[serde(default)]
    pub commit_check: String,
    pub url: String,
}

/// A self-describing runtime bundle. The manifest is deliberately inside the
/// archive so a runtime can be moved to a second PC without requiring that PC
/// to have CMake, a compiler, or the vendor SDK that produced it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeBundleManifest {
    pub format: u32,
    pub backend: String,
    pub build: String,
    pub platform: String,
    pub architecture: String,
    #[serde(default)]
    pub version: Option<RuntimeVersion>,
    #[serde(default)]
    pub source: Option<RuntimeSource>,
    pub files: Vec<RuntimeBundleFile>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeBundleFile {
    /// POSIX separators make the manifest stable when a Windows bundle is
    /// inspected or imported by another platform.
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeBundleInfo {
    pub path: String,
    pub backend: String,
    pub build: String,
    pub archive_sha256: String,
    pub bytes: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PullRequestArtifactPreview {
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Everything the user is shown before a PR build is allowed to start.
///
/// Building a pull request runs code from whoever opened it on the user's own
/// machine, so this is presented and confirmed first, and the confirmed
/// `commit` is passed back to the installer and re-checked there.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PullRequestPreview {
    pub pull_request: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub repository: String,
    pub head_ref: String,
    pub commit: String,
    pub fork: bool,
    pub url: String,
    pub archive_url: String,
    /// When GitHub last saw the pull request change, so a preview that has
    /// been sitting on screen is visibly old.
    pub updated_at: String,
    /// Machine-readable reasons this pull request deserves a second look,
    /// resolved to text by the frontend so they can be translated.
    pub advisories: Vec<String>,
    /// A repository-produced binary for this exact platform/backend, when
    /// available. Its ZIP and embedded manifest are verified again at install.
    #[serde(default)]
    pub artifact: Option<PullRequestArtifactPreview>,
    /// A non-fatal lookup failure is retained so the UI can distinguish
    /// "there is no artifact" from a temporary GitHub/API problem.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_error: Option<String>,
}

/// Reasons to look twice before building a pull request.
///
/// None of these refuses the build - each one is a legitimate thing to compile,
/// and the user may know exactly why they want it. They exist so a state that
/// changes what the code *is* cannot pass by unmentioned.
pub const PR_ADVISORY_DRAFT: &str = "draft";
pub const PR_ADVISORY_CLOSED: &str = "closed";
pub const PR_ADVISORY_MERGED: &str = "merged";
pub const PR_ADVISORY_FORK: &str = "fork";
pub const PR_ADVISORY_STALE_BRANCH: &str = "no-head-ref";

fn pull_request_advisories(resolved: &ResolvedPullRequest) -> Vec<String> {
    let mut advisories = Vec::new();
    if resolved.draft {
        advisories.push(PR_ADVISORY_DRAFT.to_string());
    }
    match resolved.source.state.as_str() {
        "merged" => advisories.push(PR_ADVISORY_MERGED.to_string()),
        "closed" => advisories.push(PR_ADVISORY_CLOSED.to_string()),
        _ => {}
    }
    if resolved.source.fork {
        advisories.push(PR_ADVISORY_FORK.to_string());
    }
    // A head with no branch name is a pull request whose branch was deleted
    // after it closed; the commit still exists, but nothing tracks it any more.
    if resolved.source.head_ref.trim().is_empty() {
        advisories.push(PR_ADVISORY_STALE_BRANCH.to_string());
    }
    advisories
}

/// Parses `version: 0.3.0-dev (build 10638, commit bf9421646)`.
pub fn parse_runtime_version(text: &str) -> Option<RuntimeVersion> {
    let line = text.lines().find(|line| line.contains("version:"))?;
    let after = line.split("version:").nth(1)?.trim();
    let (semver, rest) = after.split_once('(')?;
    let semver = semver.trim();
    if semver.is_empty() {
        return None;
    }
    let inside = rest.split_once(')')?.0;
    let mut build = None;
    let mut commit = String::new();
    for field in inside.split(',') {
        let field = field.trim();
        if let Some(value) = field.strip_prefix("build ") {
            build = value.trim().parse::<u64>().ok();
        } else if let Some(value) = field.strip_prefix("commit ") {
            commit = value.trim().to_string();
        }
    }
    Some(RuntimeVersion {
        semver: semver.to_string(),
        build: build?,
        commit,
    })
}

fn write_version_manifest(dir: &Path, version: &RuntimeVersion) {
    if let Ok(json) = serde_json::to_string(version) {
        let _ = fs::write(dir.join(VERSION_MANIFEST), json);
    }
}

fn write_source_manifest(dir: &Path, source: &RuntimeSource) -> Result<(), String> {
    let json = serde_json::to_string(source)
        .map_err(|error| format!("failed to encode source manifest: {error}"))?;
    fs::write(dir.join(SOURCE_MANIFEST), json)
        .map_err(|error| format!("failed to record source manifest: {error}"))
}

fn read_version_manifest(dir: &Path) -> Option<RuntimeVersion> {
    let raw = fs::read_to_string(dir.join(VERSION_MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_source_manifest(dir: &Path) -> Option<RuntimeSource> {
    let raw = fs::read_to_string(dir.join(SOURCE_MANIFEST)).ok()?;
    serde_json::from_str(&raw).ok()
}

#[derive(Serialize, Clone, Debug)]
pub struct InstalledRuntime {
    pub build: String,
    pub backend: String,
    pub dir: String,
    pub size_mb: f64,
    /// Absent for runtimes installed before the manifest existed; probing the
    /// runtime backfills it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<RuntimeVersion>,
    /// Present when this runtime was built from an upstream pull request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeSource>,
    /// What this install replaced, when it replaced a PR build of a different
    /// commit. Set only by a fresh install, never by listing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced: Option<RuntimeReplacement>,
}

/// A PR runtime keeps one directory per pull request - `pr27342-cuda` - so a
/// rebuild of the same PR replaces the previous build rather than filling the
/// disk with a copy per commit.
///
/// That is the right default, but it means the bytes behind a runtime can
/// change without its name changing. This records the swap so the UI can say
/// which commit went away instead of silently showing the same row.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RuntimeReplacement {
    pub previous_commit: String,
    pub previous_pull_request: u64,
}

/// First seven characters of a commit - what Git itself abbreviates to, and
/// enough to recognise in a row label.
pub fn short_commit(commit: &str) -> String {
    commit.chars().take(7).collect()
}

/// Decide what a new PR build is doing to whatever is already installed.
///
/// `None` when nothing is being displaced or when the same commit is being
/// rebuilt: neither is news, and reporting them would train the user to ignore
/// the message that matters.
fn runtime_replacement(
    existing: Option<&RuntimeSource>,
    incoming: &RuntimeSource,
) -> Option<RuntimeReplacement> {
    let existing = existing?;
    if existing.commit.is_empty() || existing.commit == incoming.commit {
        return None;
    }
    Some(RuntimeReplacement {
        previous_commit: existing.commit.clone(),
        previous_pull_request: existing.pull_request,
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct LatestInfo {
    pub build: String,
    pub file_name: String,
    pub url: String,
    pub digest: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RuntimeCapabilities {
    pub backend: String,
    pub build: String,
    pub executable: String,
    pub state: String,
    pub version: String,
    pub flags: Vec<String>,
    pub devices: Vec<String>,
    pub diagnostics: Vec<String>,
    #[serde(default)]
    pub bench_available: bool,
}

/// How many times a directory removal is retried before it is given up on.
///
/// On Windows a just-exited compiler, Explorer, or the on-access virus scanner
/// can still hold a handle to a file in the build tree for a moment after the
/// process that created it exited. A couple of spaced retries turn that into a
/// success; an unbounded retry loop would turn a genuinely locked file into a
/// background thread that never ends.
const CLEANUP_ATTEMPTS: u32 = 3;
const CLEANUP_RETRY_DELAY: Duration = Duration::from_millis(250);
/// A crashed process can leave a multi-gigabyte PR workspace behind. Seven
/// days is deliberately conservative: a long-running compile and a user
/// directory that happens to resemble our names both remain untouched for a
/// useful amount of time before startup cleanup considers them stale.
const ORPHAN_SWEEP_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const PR_WORKSPACE_NONCE_LEN: usize = 12;
const RUNTIME_BACKUP_NONCE_LEN: usize = 32;
const RUNTIME_IMPORT_NONCE_LEN: usize = 12;

/// Remove a directory tree, retrying a bounded number of times.
///
/// Blocking and potentially very slow: a llama.cpp build tree is several GB
/// across hundreds of thousands of objects. It must only ever run on a
/// blocking thread, never on a Tokio runtime worker.
fn remove_tree_bounded(directory: &Path) -> Result<(), String> {
    for attempt in 0..CLEANUP_ATTEMPTS {
        match fs::remove_dir_all(directory) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                if attempt + 1 == CLEANUP_ATTEMPTS {
                    return Err(format!("{}: {error}", directory.display()));
                }
                std::thread::sleep(CLEANUP_RETRY_DELAY);
            }
        }
    }
    Ok(())
}

/// The removals a finished or abandoned install leaves behind.
///
/// Separated from `InstallCleanup` so the work can be moved onto a blocking
/// thread and outlive the async task that scheduled it: a cancelled install
/// still has to delete its several-GB build tree.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
struct CleanupPlan {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
}

impl CleanupPlan {
    fn is_empty(&self) -> bool {
        self.files.is_empty() && self.directories.is_empty()
    }

    /// Blocking. Best-effort: a file that cannot be removed is left for the
    /// next install of the same runtime to overwrite, never retried forever.
    fn run(&self) {
        for file in &self.files {
            let _ = fs::remove_file(file);
        }
        for directory in &self.directories {
            let _ = remove_tree_bounded(directory);
        }
    }

    /// Run the plan without ever blocking a Tokio worker.
    ///
    /// Inside a runtime the work is handed to the blocking pool, which is what
    /// makes it safe from `Drop`: the returned handle is dropped immediately
    /// but the task keeps running, so a cancelled install still cleans up.
    fn spawn(self) {
        if self.is_empty() {
            return;
        }
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn_blocking(move || self.run());
            }
            // No runtime (tests, shutdown): nothing to protect, so do it here.
            Err(_) => self.run(),
        }
    }
}

struct InstallCleanup {
    archives: Vec<PathBuf>,
    directories: Vec<PathBuf>,
    staging: PathBuf,
    committed: bool,
    /// Set once the plan has been handed off, so `Drop` does not repeat it.
    settled: bool,
}

impl InstallCleanup {
    fn new(archive: PathBuf, staging: PathBuf) -> Self {
        Self {
            archives: vec![archive],
            directories: Vec::new(),
            staging,
            committed: false,
            settled: false,
        }
    }

    /// Track an extra downloaded archive (e.g. the CUDA runtime sidecar) so it
    /// is removed on both the success and the failure path.
    fn track_archive(&mut self, archive: PathBuf) {
        self.archives.push(archive);
    }

    fn track_directory(&mut self, directory: PathBuf) {
        self.directories.push(directory);
    }

    fn commit(&mut self) {
        self.committed = true;
    }

    fn plan(&self) -> CleanupPlan {
        let mut directories = self.directories.clone();
        if !self.committed {
            directories.push(self.staging.clone());
        }
        CleanupPlan {
            files: self.archives.clone(),
            directories,
        }
    }

    /// Run the cleanup on a blocking thread and wait for it.
    ///
    /// The normal exit path: the caller is still on the install task, so it
    /// can afford to wait, and waiting means the next install of the same
    /// runtime does not race this one's removals.
    async fn finish(mut self) {
        let plan = self.plan();
        self.settled = true;
        if plan.is_empty() {
            return;
        }
        let _ = tokio::task::spawn_blocking(move || plan.run()).await;
    }
}

impl Drop for InstallCleanup {
    /// The abandoned path - the install future was cancelled or unwound - so
    /// hand the work to the blocking pool and return immediately. Doing it
    /// inline here would stall a runtime worker for as long as it takes to
    /// delete a multi-GB build tree.
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        self.plan().spawn();
    }
}

fn valid_hex_nonce(value: &str, length: usize) -> bool {
    value.len() == length && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn valid_runtime_directory_stem(stem: &str) -> bool {
    let Some((build, backend)) = stem.split_once('-') else {
        return false;
    };
    validate_runtime_identifiers(backend, build).is_ok()
}

/// Exact allowlist for the source-build workspace names created by this file:
/// `.<12 hex>-pr<digits>-<backend>`. No glob or prefix-only deletion is used
/// here, so a user directory such as `.project-pr27342-cuda` is preserved.
fn is_pr_download_workspace_name(name: &str) -> bool {
    let Some(name) = name.strip_prefix('.') else {
        return false;
    };
    let Some((nonce, stem)) = name.split_once('-') else {
        return false;
    };
    if !valid_hex_nonce(nonce, PR_WORKSPACE_NONCE_LEN) {
        return false;
    }
    let Some((build, backend)) = stem.split_once('-') else {
        return false;
    };
    build.starts_with("pr")
        && SOURCE_BUILD_BACKENDS.contains(&backend)
        && valid_runtime_directory_stem(stem)
}

/// Exact allowlist for runtime staging and backup directories. The nonce for a
/// staging path is short; replacement backups retain the full UUID nonce.
fn is_runtime_staging_or_backup_name(name: &str) -> bool {
    if let Some(nonce) = name.strip_prefix(".runtime-import-") {
        return valid_hex_nonce(nonce, RUNTIME_IMPORT_NONCE_LEN);
    }
    if let Some(nonce) = name.strip_prefix(".runtime-export-") {
        return valid_hex_nonce(nonce, RUNTIME_IMPORT_NONCE_LEN);
    }
    let Some(name) = name.strip_prefix('.') else {
        return false;
    };
    for (marker, nonce_len) in [
        (".staging-", PR_WORKSPACE_NONCE_LEN),
        (".backup-", RUNTIME_BACKUP_NONCE_LEN),
    ] {
        if let Some((stem, nonce)) = name.split_once(marker) {
            let backend = stem.split_once('-').map(|(_, backend)| backend);
            return valid_hex_nonce(nonce, nonce_len)
                && backend.is_some_and(|backend| CATALOG_BACKENDS.contains(&backend))
                && valid_runtime_directory_stem(stem);
        }
    }
    false
}

/// Exact allowlist for downloaded ZIPs. The asset basename was validated
/// before the download, so only a fresh 12-hex nonce and a safe ZIP basename
/// are needed here. User files in the downloads directory do not match.
fn is_runtime_download_file_name(name: &str) -> bool {
    let Some(name) = name.strip_prefix('.') else {
        return false;
    };
    let Some((nonce, asset)) = name.split_once('-') else {
        return false;
    };
    valid_hex_nonce(nonce, PR_WORKSPACE_NONCE_LEN) && validate_asset_file_name(asset).is_ok()
}

fn is_stale_directory(path: &Path, now: SystemTime) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|metadata| metadata.modified()) else {
        return false;
    };
    now.duration_since(modified)
        .map(|age| age >= ORPHAN_SWEEP_MAX_AGE)
        .unwrap_or(false)
}

fn sweep_orphaned_work_in_with(
    download_root: &Path,
    runtime_root: &Path,
    now: SystemTime,
    remove_tree: fn(&Path) -> Result<(), String>,
) {
    let sweep = |root: &Path, matches: fn(&str) -> bool| {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            // Never follow or remove a symlink, even if its name matches.
            if !metadata.is_dir() || metadata.file_type().is_symlink() || !matches(&name) {
                continue;
            }
            if is_stale_directory(&path, now) {
                // Locked directories are expected on Windows (or when an old
                // compiler is still alive). Removal is best effort and must
                // never turn startup into a failure.
                let _ = remove_tree(&path);
            }
        }
    };
    let sweep_files = |root: &Path, matches: fn(&str) -> bool| {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() || !matches(&name) {
                continue;
            }
            if is_stale_directory(&path, now) {
                let _ = fs::remove_file(&path);
            }
        }
    };
    sweep_files(download_root, is_runtime_download_file_name);
    sweep(download_root, is_pr_download_workspace_name);
    sweep(runtime_root, is_runtime_staging_or_backup_name);
}

fn sweep_orphaned_work_in(download_root: &Path, runtime_root: &Path, now: SystemTime) {
    sweep_orphaned_work_in_with(download_root, runtime_root, now, remove_tree_bounded);
}

/// Best-effort startup cleanup for work left by a crashed or force-closed
/// source build. All filesystem work runs on the blocking pool and failures
/// are intentionally ignored; managed runtimes and user directories are not
/// touched by the exact-name allowlists above.
pub fn sweep_orphaned_work() {
    let download_root = app_data_root().join("llama-board").join("downloads");
    let runtime_root = runtimes_root();
    sweep_orphaned_work_in(&download_root, &runtime_root, SystemTime::now());
}

#[derive(Deserialize, Clone, Debug)]
struct Rel {
    tag_name: String,
}

#[derive(Deserialize, Clone, Debug)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PullRequestRef {
    number: u64,
}

#[derive(Deserialize, Clone, Debug)]
struct PullRequestRepository {
    full_name: String,
}

#[derive(Deserialize, Clone, Debug)]
struct PullRequestHead {
    sha: String,
    #[serde(default, rename = "ref")]
    reference: String,
    repo: Option<PullRequestRepository>,
}

#[derive(Deserialize, Clone, Debug)]
struct PullRequestUser {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize, Clone, Debug)]
struct PullRequestDetail {
    number: u64,
    head: PullRequestHead,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    merged_at: Option<String>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    user: Option<PullRequestUser>,
}

fn app_data_root() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
    }
    #[cfg(target_os = "macos")]
    {
        return PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join("Library")
            .join("Application Support");
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        if let Ok(path) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(path);
        }
        return PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join(".local")
            .join("share");
    }
}

pub fn runtimes_root() -> PathBuf {
    app_data_root().join("llama-board").join("runtimes")
}

pub fn validate_runtime_identifiers(backend: &str, build: &str) -> Result<(), String> {
    if backend.is_empty()
        || backend.len() > 64
        || !backend
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || ".-_".contains(value))
    {
        return Err(format!("invalid runtime backend identifier: {backend}"));
    }
    let valid_release_build = build.starts_with('b')
        && build.len() >= 2
        && build.len() <= 16
        && build[1..].chars().all(|value| value.is_ascii_digit());
    let valid_pull_request_build = build.starts_with("pr")
        && build.len() >= 3
        && build.len() <= 20
        && build[2..].chars().all(|value| value.is_ascii_digit())
        && build[2..]
            .parse::<u64>()
            .map(|number| number > 0)
            .unwrap_or(false);
    if !valid_release_build && !valid_pull_request_build {
        return Err(format!("invalid runtime build identifier: {build}"));
    }
    if backend.contains(['/', '\\']) || build.contains(['/', '\\']) {
        return Err("runtime identifiers must not contain path separators".into());
    }
    Ok(())
}

pub fn runtime_dir(backend: &str, build: &str) -> Result<PathBuf, String> {
    validate_runtime_identifiers(backend, build)?;
    Ok(runtimes_root().join(format!("{build}-{backend}")))
}

pub fn server_executable_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

pub fn bench_executable_name() -> &'static str {
    if cfg!(windows) {
        "llama-bench.exe"
    } else {
        "llama-bench"
    }
}

pub fn server_bin_for(backend: &str, build: &str) -> Result<PathBuf, String> {
    Ok(runtime_dir(backend, build)?.join(server_executable_name()))
}

pub fn bench_bin_for(backend: &str, build: &str) -> Result<PathBuf, String> {
    Ok(runtime_dir(backend, build)?.join(bench_executable_name()))
}

/// Names every spawned child may inherit, on every platform: enough of the OS
/// for a process to start, find its temp directory, and format messages.
const BASE_ENVIRONMENT: &[&str] = &["PATH", "HOME", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];

/// Windows needs considerably more than PATH before a process can start: the
/// CRT, the loader, and every SDK's CMake package resolve their own locations
/// through these. A build that inherits only PATH configures on the machine it
/// was developed on and fails on the next PC, which is the failure this list
/// exists to prevent.
#[cfg(windows)]
const PLATFORM_ENVIRONMENT: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_ARCHITEW6432",
    "OS",
];

#[cfg(target_os = "macos")]
const PLATFORM_ENVIRONMENT: &[&str] = &[
    "USER",
    "LOGNAME",
    "SHELL",
    "XDG_CACHE_HOME",
    "DYLD_FALLBACK_LIBRARY_PATH",
];

#[cfg(all(unix, not(target_os = "macos")))]
const PLATFORM_ENVIRONMENT: &[&str] = &[
    "USER",
    "LOGNAME",
    "SHELL",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "LD_LIBRARY_PATH",
];

/// GPU-stack names a *runtime* child needs to enumerate and select a device.
const RUNTIME_DEVICE_ENVIRONMENT: &[&str] = &[
    "VK_ICD_FILENAMES",
    "VK_DRIVER_FILES",
    "VK_LAYER_PATH",
    "VK_INSTANCE_LAYERS",
    "VK_ADD_LAYER_PATH",
    "VK_LOADER_DEBUG",
    "VK_LOADER_DRIVERS_SELECT",
    "DISABLE_LAYER_AMD_SWITCHABLE_GRAPHICS_1",
    "CUDA_VISIBLE_DEVICES",
    "CUDA_DEVICE_ORDER",
    "CUDA_PATH",
    "CUDA_MODULE_LOADING",
    "HIP_VISIBLE_DEVICES",
    "ROCR_VISIBLE_DEVICES",
    "HIP_PATH",
    "ROCM_PATH",
    "HSA_OVERRIDE_GFX_VERSION",
    "HSA_ENABLE_SDMA",
    "GPU_MAX_HW_QUEUES",
    "AMD_SERIALIZE_KERNEL",
    "HSA_XNACK",
    "ROCBLAS_TENSILE_LIBPATH",
    "HIPBLASLT_TENSILE_LIBPATH",
    "ONEAPI_DEVICE_SELECTOR",
    "SYCL_DEVICE_FILTER",
    "ZE_AFFINITY_MASK",
    "GGML_VK_VISIBLE_DEVICES",
    "GGML_CUDA_VISIBLE_DEVICES",
];

/// Toolchain roots. Every SDK below publishes its CMake package through one of
/// these, so dropping them turns a working machine into "SDK not found".
const BUILD_TOOLCHAIN_ENVIRONMENT: &[&str] = &[
    "CUDA_PATH",
    "CUDA_HOME",
    "CUDA_TOOLKIT_ROOT_DIR",
    "CUDACXX",
    "CUDAHOSTCXX",
    "CUDAFLAGS",
    "NVCC_CCBIN",
    "HIPCXX",
    "HIPCC",
    "VULKAN_SDK",
    "VK_SDK_PATH",
    "HIP_PATH",
    "ROCM_PATH",
    "ONEAPI_ROOT",
    "VCPKG_ROOT",
    "VCPKG_DEFAULT_TRIPLET",
    "PKG_CONFIG_PATH",
    "PKG_CONFIG_LIBDIR",
];

/// CMake, the generator it picks, and the compiler driver underneath it.
const BUILD_TOOLING_ENVIRONMENT: &[&str] = &[
    "CMAKE_PREFIX_PATH",
    "CMAKE_TOOLCHAIN_FILE",
    "CMAKE_GENERATOR",
    "CMAKE_GENERATOR_PLATFORM",
    "CMAKE_GENERATOR_TOOLSET",
    "CMAKE_GENERATOR_INSTANCE",
    "CMAKE_MAKE_PROGRAM",
    "CMAKE_BUILD_PARALLEL_LEVEL",
    "CMAKE_C_COMPILER_LAUNCHER",
    "CMAKE_CXX_COMPILER_LAUNCHER",
    "NINJA_STATUS",
    "MAKEFLAGS",
    "CC",
    "CXX",
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
];

/// The compiler environment a Visual Studio developer prompt exports. CMake
/// finds MSVC through the registry on its own, but when llama-board itself was
/// launched from a developer prompt these describe the *selected* toolset, and
/// dropping half of them produces a configure that mixes two.
#[cfg(windows)]
const BUILD_PLATFORM_ENVIRONMENT: &[&str] = &[
    "INCLUDE",
    "LIB",
    "LIBPATH",
    "VSINSTALLDIR",
    "VCINSTALLDIR",
    "VCToolsInstallDir",
    "VCToolsVersion",
    "VCToolsRedistDir",
    "WindowsSdkDir",
    "WindowsSdkVerBinPath",
    "WindowsSDKVersion",
    "UniversalCRTSdkDir",
    "UCRTVersion",
    "VSCMD_ARG_HOST_ARCH",
    "VSCMD_ARG_TGT_ARCH",
];

/// Xcode's active toolchain and deployment target. Without `DEVELOPER_DIR` a
/// machine with more than one Xcode picks a different SDK than the user's own
/// terminal does.
#[cfg(target_os = "macos")]
const BUILD_PLATFORM_ENVIRONMENT: &[&str] =
    &["DEVELOPER_DIR", "SDKROOT", "MACOSX_DEPLOYMENT_TARGET"];

#[cfg(all(unix, not(target_os = "macos")))]
const BUILD_PLATFORM_ENVIRONMENT: &[&str] = &["LIBRARY_PATH", "CPATH", "C_INCLUDE_PATH"];

/// Proxy, TLS-trust and Git names.
///
/// A source build reaches the network - the source archive aside, CMake and
/// any generator step may resolve a dependency - and on a corporate PC that
/// only works through the configured proxy and the corporate CA bundle.
///
/// These are the one category here that can legitimately carry a credential: a
/// proxy URL of the form `http://user:password@proxy` puts one in
/// `HTTPS_PROXY`. That is the user's own proxy credential, it is passed only
/// to CMake and its generator, and without it the build cannot reach anything
/// at all. It is documented in SECURITY.md rather than silently dropped.
const BUILD_NETWORK_ENVIRONMENT: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "GIT_SSL_CAPATH",
    "GIT_EXEC_PATH",
];

/// Collect the values of `names` that are actually set, in order, without
/// duplicating a name that appears in more than one category.
fn collect_environment(groups: &[&[&str]]) -> Vec<(OsString, OsString)> {
    let mut seen = std::collections::HashSet::new();
    let mut environment = Vec::new();
    for name in groups.iter().flat_map(|group| group.iter()) {
        if !seen.insert(*name) {
            continue;
        }
        if let Some(value) = std::env::var_os(name) {
            environment.push((OsString::from(*name), value));
        }
    }
    environment
}

pub fn child_environment() -> Vec<(OsString, OsString)> {
    collect_environment(&[
        BASE_ENVIRONMENT,
        PLATFORM_ENVIRONMENT,
        RUNTIME_DEVICE_ENVIRONMENT,
    ])
}

/// Environment names that can make a staged runtime appear healthy only
/// because the build machine happens to have an SDK on its PATH. The actual
/// installed runtime must resolve its redistributable libraries from the
/// runtime directory; GPU driver libraries remain a host prerequisite.
const STAGED_RUNTIME_HOST_ENVIRONMENT: &[&str] = &[
    "PATH",
    "CUDA_PATH",
    "CUDA_HOME",
    "CUDA_TOOLKIT_ROOT_DIR",
    "CUDACXX",
    "CUDAHOSTCXX",
    "VULKAN_SDK",
    "VK_SDK_PATH",
    "HIP_PATH",
    "ROCM_PATH",
    "ONEAPI_ROOT",
    "PKG_CONFIG_PATH",
    "PKG_CONFIG_LIBDIR",
    "CMAKE_PREFIX_PATH",
    "CMAKE_TOOLCHAIN_FILE",
    "ROCBLAS_TENSILE_LIBPATH",
    "HIPBLASLT_TENSILE_LIBPATH",
    "CC",
    "CXX",
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
];

fn staged_runtime_environment_from(
    environment: Vec<(OsString, OsString)>,
    staging: &Path,
) -> Vec<(OsString, OsString)> {
    let staging_path = staging;
    let mut environment = environment
        .into_iter()
        .filter(|(name, _)| {
            !name
                .to_str()
                .is_some_and(|name| STAGED_RUNTIME_HOST_ENVIRONMENT.contains(&name))
        })
        .collect::<Vec<_>>();
    let staging = staging.as_os_str().to_os_string();
    // Keep the loader's search path deliberately single-rooted. The executable
    // directory is searched independently on Windows, while Unix builds also
    // receive the corresponding loader variable below.
    environment.push((OsString::from("PATH"), staging.clone()));
    #[cfg(target_os = "macos")]
    environment.push((OsString::from("DYLD_LIBRARY_PATH"), staging.clone()));
    #[cfg(all(unix, not(target_os = "macos")))]
    environment.push((OsString::from("LD_LIBRARY_PATH"), staging));
    add_packaged_gpu_library_paths(&mut environment, staging_path);
    environment
}

fn staged_runtime_environment(staging: &Path) -> Vec<(OsString, OsString)> {
    staged_runtime_environment_from(child_environment(), staging)
}

fn add_packaged_gpu_library_paths(environment: &mut Vec<(OsString, OsString)>, root: &Path) {
    let paths = [
        (
            "ROCBLAS_TENSILE_LIBPATH",
            root.join("rocblas").join("library"),
        ),
        (
            "HIPBLASLT_TENSILE_LIBPATH",
            root.join("hipblaslt").join("library"),
        ),
    ];
    for (name, path) in paths {
        if path.is_dir() {
            set_environment_value(environment, name, path.into_os_string());
        }
    }
}

/// Runtime processes must not silently use a developer's installed SDK when a
/// portable bundle is being tested. Keep the normal OS/device environment,
/// replace PATH with the bundle directory, and point BLAS data loaders at
/// data copied into that directory.
pub fn child_environment_for_runtime(
    backend: &str,
    build: &str,
) -> Result<Vec<(OsString, OsString)>, String> {
    let root = runtime_dir(backend, build)?;
    let mut environment = child_environment();
    for name in [
        "CUDA_PATH",
        "CUDA_HOME",
        "CUDA_TOOLKIT_ROOT_DIR",
        "CUDACXX",
        "CUDAHOSTCXX",
        "VULKAN_SDK",
        "VK_SDK_PATH",
        "HIP_PATH",
        "ROCM_PATH",
        "ONEAPI_ROOT",
        "ROCBLAS_TENSILE_LIBPATH",
        "HIPBLASLT_TENSILE_LIBPATH",
    ] {
        environment.retain(|(key, _)| key != OsStr::new(name));
    }
    set_environment_value(&mut environment, "PATH", root.as_os_str().to_os_string());
    #[cfg(unix)]
    set_environment_value(
        &mut environment,
        "LD_LIBRARY_PATH",
        root.as_os_str().to_os_string(),
    );
    add_packaged_gpu_library_paths(&mut environment, &root);
    Ok(environment)
}

/// Keep the source-build environment small enough that a CMake configure does
/// not inherit credentials or unrelated application state, and large enough
/// that the same PR builds on someone else's PC.
fn build_environment() -> Vec<(OsString, OsString)> {
    let mut environment = collect_environment(&[
        BASE_ENVIRONMENT,
        PLATFORM_ENVIRONMENT,
        BUILD_TOOLCHAIN_ENVIRONMENT,
        BUILD_TOOLING_ENVIRONMENT,
        BUILD_PLATFORM_ENVIRONMENT,
        BUILD_NETWORK_ENVIRONMENT,
    ]);
    environment.extend(build_environment_overrides());
    environment
}

/// Values the build child is *given* rather than allowed to inherit, because
/// each one closes a failure mode instead of carrying configuration.
fn build_environment_overrides() -> Vec<(OsString, OsString)> {
    [
        // A Git or credential helper that stops to ask for a password would
        // hang forever behind a pipe no human can see. Make it fail instead.
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GCM_INTERACTIVE", "Never"),
        // Anything CMake downloads itself must still validate TLS, even if the
        // user's shell profile turned that off globally.
        ("CMAKE_TLS_VERIFY", "1"),
    ]
    .into_iter()
    .map(|(name, value)| (OsString::from(name), OsString::from(value)))
    .collect()
}

/// Names that must never reach a child, whatever list they are added to.
///
/// The allowlists above already exclude everything by construction; this is
/// the assertion a future edit is checked against, so widening a category
/// cannot quietly hand a build a token.
#[cfg(test)]
fn is_credential_name(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "SSH_AUTH_SOCK",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "NPM_TOKEN",
        "CARGO_REGISTRY_TOKEN",
    ];
    const FRAGMENTS: &[&str] = &[
        "token",
        "secret",
        "password",
        "passwd",
        "apikey",
        "api_key",
        "credential",
        "private_key",
    ];
    let lowered = name.to_ascii_lowercase();
    EXACT.iter().any(|exact| exact.eq_ignore_ascii_case(name))
        || FRAGMENTS.iter().any(|fragment| lowered.contains(fragment))
}

fn build_environment_with_tool(tool: &Path) -> Vec<(OsString, OsString)> {
    let mut environment = build_environment();
    let Some(tool_dir) = tool.parent() else {
        return environment;
    };

    let existing_path = environment
        .iter()
        .find(|(key, _)| key == OsStr::new("PATH"))
        .map(|(_, value)| value.clone());
    let mut path_entries = vec![tool_dir.to_path_buf()];

    // Visual Studio ships Ninja beside its bundled CMake, while standalone
    // CMake distributions may put ninja.exe directly in the same bin folder.
    // Keep all known layouts in the child PATH so a GUI-launched app does not
    // need a developer prompt or a globally edited PATH.
    let mut ninja_dirs = vec![tool_dir.to_path_buf(), tool_dir.join("Ninja")];
    if let Some(parent) = tool_dir.parent() {
        ninja_dirs.push(parent.join("Ninja"));
        if let Some(grandparent) = parent.parent() {
            ninja_dirs.push(grandparent.join("Ninja"));
        }
    }
    for ninja_dir in ninja_dirs {
        if ninja_dir.is_dir() {
            path_entries.push(ninja_dir);
        }
    }
    // `cl.exe` is often found by the preflight through Visual Studio's
    // install tree rather than the user's PATH. Keep that same discovery
    // effective for CMake's compiler probe; a successful preflight must not
    // be followed by a configure that cannot launch the compiler.
    #[cfg(windows)]
    if let Some(compiler_dir) =
        locate_tool("cl").and_then(|path| path.parent().map(Path::to_path_buf))
    {
        path_entries.push(compiler_dir);
    }
    if let Some(existing_path) = existing_path {
        path_entries.extend(std::env::split_paths(&existing_path));
    }

    if let Ok(path) = std::env::join_paths(path_entries) {
        if let Some((_, value)) = environment
            .iter_mut()
            .find(|(key, _)| key == OsStr::new("PATH"))
        {
            *value = path;
        } else {
            environment.push((OsString::from("PATH"), path));
        }
    }
    environment
}

fn set_environment_value(
    environment: &mut Vec<(OsString, OsString)>,
    name: &str,
    value: impl Into<OsString>,
) {
    let value = value.into();
    if let Some((_, current)) = environment
        .iter_mut()
        .find(|(key, _)| key == OsStr::new(name))
    {
        *current = value;
    } else {
        environment.push((OsString::from(name), value));
    }
}

fn prepend_environment_paths(environment: &mut Vec<(OsString, OsString)>, prefixes: &[PathBuf]) {
    let existing = environment
        .iter()
        .find(|(key, _)| key == OsStr::new("PATH"))
        .map(|(_, value)| value.clone());
    let mut paths = prefixes.to_vec();
    if let Some(existing) = existing {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        set_environment_value(environment, "PATH", path);
    }
}

/// Add the selected vendor SDK to the build child even when the user installed
/// it in a standard location that did not export its root variables. The
/// preflight and the packaging code use the same compiler-derived root, so the
/// compiler, CMake's package lookup, and staged sidecars cannot silently come
/// from three different SDK versions.
fn build_environment_for_backend(tool: &Path, backend: &str) -> Vec<(OsString, OsString)> {
    let mut environment = build_environment_with_tool(tool);
    #[cfg(windows)]
    if let Some(cl) = locate_tool("cl") {
        merge_visual_studio_environment(&mut environment, &cl);
    }
    let (root, variable_names): (Option<PathBuf>, &[&str]) = match backend {
        "cuda" => (sdk_root_from_tool("nvcc"), &["CUDA_PATH", "CUDA_HOME"]),
        "rocm" => (sdk_root_from_tool("hipcc"), &["HIP_PATH", "ROCM_PATH"]),
        "vulkan" => (sdk_root_from_tool("glslc"), &["VULKAN_SDK"]),
        _ => (None, &[]),
    };
    let Some(root) = root else {
        return environment;
    };
    for variable in variable_names {
        if !environment
            .iter()
            .any(|(name, _)| name == OsStr::new(variable))
        {
            set_environment_value(&mut environment, variable, root.as_os_str().to_os_string());
        }
    }
    let mut path_prefixes = vec![root.join("bin")];
    if backend == "rocm" {
        path_prefixes.push(root.join("llvm").join("bin"));
        if let Some(hipcc) = locate_tool("hipcc") {
            if let Some(parent) = hipcc.parent() {
                path_prefixes.push(parent.to_path_buf());
            }
        }
        // Linux CMake uses HIPCXX when it enables the HIP language. Windows
        // uses clang++ as an ordinary C++ compiler instead (see the configure
        // arguments below), but setting this when available is harmless and
        // helps mixed ROCm toolchains choose the same compiler everywhere.
        let mut clangxx_candidates = vec![
            root.join("llvm").join("bin").join("clang++"),
            root.join("bin").join("clang++"),
        ];
        #[cfg(windows)]
        for path in &mut clangxx_candidates {
            path.set_extension("exe");
        }
        if let Some(clangxx) = clangxx_candidates.into_iter().find(|path| path.is_file()) {
            set_environment_value(
                &mut environment,
                "HIPCXX",
                clangxx.as_os_str().to_os_string(),
            );
        }
        #[cfg(windows)]
        if let Some(ninja) = locate_ninja() {
            if let Some(parent) = ninja.parent() {
                path_prefixes.push(parent.to_path_buf());
            }
        }
    }
    path_prefixes.retain(|path| path.is_dir());
    prepend_environment_paths(&mut environment, &path_prefixes);
    environment
}

#[cfg(windows)]
fn merge_visual_studio_environment(environment: &mut Vec<(OsString, OsString)>, cl: &Path) {
    let Some(vc_root) = cl.ancestors().find(|path| {
        path.file_name()
            .is_some_and(|name| name == OsStr::new("VC"))
    }) else {
        return;
    };
    let vcvarsall = vc_root
        .join("Auxiliary")
        .join("Build")
        .join("vcvarsall.bat");
    if vcvarsall.is_file() {
        let comspec = std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
        let command_line = format!("call \"{}\" x64 >nul && set", vcvarsall.display());
        if let Ok(output) = std::process::Command::new(comspec)
            .env_clear()
            .envs(child_environment())
            .args(["/d", "/s", "/c", &command_line])
            .output()
        {
            if output.status.success() {
                const NAMES: &[&str] = &[
                    "PATH",
                    "INCLUDE",
                    "LIB",
                    "LIBPATH",
                    "VCToolsInstallDir",
                    "VCToolsVersion",
                    "VCToolsRedistDir",
                    "WindowsSdkDir",
                    "WindowsSdkVerBinPath",
                    "WindowsSDKVersion",
                    "UniversalCRTSdkDir",
                    "UCRTVersion",
                    "VSCMD_ARG_HOST_ARCH",
                    "VSCMD_ARG_TGT_ARCH",
                ];
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let Some((name, value)) = line.split_once('=') else {
                        continue;
                    };
                    if !NAMES.contains(&name) {
                        continue;
                    }
                    if name == "PATH" {
                        append_environment_paths(environment, OsStr::new(value));
                    } else {
                        set_environment_value(environment, name, OsString::from(value));
                    }
                }
            }
        }
    }

    // `vcvarsall.bat` is the supported entry point, but it can fail when the
    // app was launched by a GUI with a reduced environment (or when cmd uses
    // a non-UTF code page). Clang still needs the import and library search
    // paths even in that case. Reconstruct them from the compiler and SDK
    // layout instead of letting the link fail with an opaque kernel32.lib
    // error after configure has already started.
    if !cl.ancestors().any(|path| {
        path.file_name()
            .is_some_and(|name| name == OsStr::new("MSVC"))
            && path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == OsStr::new("Tools"))
    }) {
        return;
    }
    let Some(toolset_version) = cl.ancestors().find(|path| {
        path.parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == OsStr::new("MSVC"))
    }) else {
        return;
    };

    let sdk_root = environment_value(environment, "WindowsSdkDir")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(windows_sdk_root);
    let sdk_version = sdk_root.as_deref().and_then(|root| {
        environment_value(environment, "WindowsSDKVersion")
            .map(|value| {
                value
                    .to_string_lossy()
                    .trim_matches(['\\', '/'])
                    .to_string()
            })
            .filter(|version| root.join("Include").join(version).is_dir())
            .map(PathBuf::from)
            .or_else(|| {
                newest_directory(&root.join("Include"))
                    .and_then(|path| path.file_name().map(PathBuf::from))
            })
    });

    let mut include_paths = vec![toolset_version.join("include")];
    let visual_studio_include = vc_root.join("Auxiliary").join("VS").join("include");
    include_paths.push(visual_studio_include);
    if let (Some(root), Some(version)) = (sdk_root.as_deref(), sdk_version.as_deref()) {
        for name in ["ucrt", "um", "shared", "winrt", "cppwinrt"] {
            include_paths.push(root.join("Include").join(version).join(name));
        }
    }
    include_paths.retain(|path| path.is_dir());
    merge_path_variable(environment, "INCLUDE", &include_paths);

    let mut lib_paths = vec![toolset_version.join("lib").join("x64")];
    if let (Some(root), Some(version)) = (sdk_root.as_deref(), sdk_version.as_deref()) {
        for name in ["ucrt", "um"] {
            lib_paths.push(root.join("Lib").join(version).join(name).join("x64"));
        }
    }
    lib_paths.retain(|path| path.is_dir());
    merge_path_variable(environment, "LIB", &lib_paths);

    let mut libpath_paths = lib_paths;
    if let (Some(root), Some(version)) = (sdk_root.as_deref(), sdk_version.as_deref()) {
        libpath_paths.push(root.join("UnionMetadata").join(version));
        libpath_paths.push(root.join("References").join(version));
    }
    libpath_paths.retain(|path| path.is_dir());
    merge_path_variable(environment, "LIBPATH", &libpath_paths);

    let mut path_prefixes = vec![cl.parent().unwrap_or(vc_root).to_path_buf()];
    if let (Some(root), Some(version)) = (sdk_root.as_deref(), sdk_version.as_deref()) {
        path_prefixes.push(root.join("bin").join(version).join("x64"));
        path_prefixes.push(root.join("bin").join(version));
    }
    path_prefixes.retain(|path| path.is_dir());
    prepend_environment_paths(environment, &path_prefixes);

    if let Some(root) = sdk_root {
        set_environment_value(environment, "WindowsSdkDir", root.into_os_string());
    }
    if let Some(version) = sdk_version {
        set_environment_value(
            environment,
            "WindowsSDKVersion",
            OsString::from(format!("{}\\", version.display())),
        );
    }
    set_environment_value(
        environment,
        "VCToolsInstallDir",
        toolset_version.to_path_buf().into_os_string(),
    );
    if let Some(version) = toolset_version.file_name() {
        set_environment_value(environment, "VCToolsVersion", version.to_os_string());
    }
}

#[cfg(windows)]
fn environment_value(environment: &[(OsString, OsString)], name: &str) -> Option<OsString> {
    environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(OsStr::new(name)))
        .map(|(_, value)| value.clone())
        .filter(|value| !value.is_empty())
}

#[cfg(windows)]
fn append_environment_paths(environment: &mut Vec<(OsString, OsString)>, additional: &OsStr) {
    let existing = environment_value(environment, "PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut paths = existing;
    paths.extend(std::env::split_paths(additional));
    if let Ok(path) = std::env::join_paths(paths) {
        set_environment_value(environment, "PATH", path);
    }
}

#[cfg(windows)]
fn merge_path_variable(environment: &mut Vec<(OsString, OsString)>, name: &str, paths: &[PathBuf]) {
    if paths.is_empty() {
        return;
    }
    let mut merged = environment_value(environment, name)
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    for path in paths {
        if !merged.iter().any(|existing| existing == path) {
            merged.push(path.clone());
        }
    }
    if let Ok(value) = std::env::join_paths(merged) {
        set_environment_value(environment, name, value);
    }
}

#[cfg(windows)]
fn newest_directory(root: &Path) -> Option<PathBuf> {
    let mut directories = fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    directories.sort_by(|left, right| right.cmp(left));
    directories.into_iter().next()
}

#[cfg(windows)]
fn windows_sdk_root() -> Option<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .map(|root| root.join("Windows Kits").join("10"))
        .find(|root| root.is_dir())
}

/// Locate Ninja in PATH or beside one of the CMake distributions that
/// llama-board already knows how to find. Windows ROCm builds deliberately use
/// Ninja because CMake's Visual Studio generator sends HIP sources to cl.exe.
fn locate_ninja() -> Option<PathBuf> {
    if let Ok(path) = which::which("ninja") {
        if path.is_file() {
            return Some(path);
        }
    }

    #[cfg(windows)]
    for cmake in windows_cmake_candidates() {
        let Some(cmake_dir) = cmake.parent() else {
            continue;
        };
        let mut ninja_dirs = vec![cmake_dir.to_path_buf(), cmake_dir.join("Ninja")];
        if let Some(parent) = cmake_dir.parent() {
            ninja_dirs.push(parent.join("Ninja"));
            if let Some(grandparent) = parent.parent() {
                ninja_dirs.push(grandparent.join("Ninja"));
            }
        }
        for directory in ninja_dirs {
            let candidate = directory.join("ninja.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

/// Visual Studio editions, most complete first.
///
/// Any edition ships the same bundled CMake, so this only decides which of two
/// equally new installs is tried first. It is spelled out rather than left to
/// directory order because `read_dir` returns entries in whatever order the
/// filesystem happens to hold them - which is not the same on two PCs, or even
/// on one PC after an update, and a build tool that changes under the user is
/// worse than one that is merely not their favourite.
#[cfg(any(windows, test))]
const VISUAL_STUDIO_EDITIONS: &[&str] = &["Enterprise", "Professional", "Community", "BuildTools"];

/// One `…/Microsoft Visual Studio/<year>/<edition>` install.
#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct VisualStudioInstall {
    year: u32,
    edition: String,
    cmake: PathBuf,
    #[cfg(windows)]
    edition_root: PathBuf,
}

#[cfg(windows)]
fn visual_studio_cmake(edition_root: &Path) -> PathBuf {
    edition_root
        .join("Common7")
        .join("IDE")
        .join("CommonExtensions")
        .join("Microsoft")
        .join("CMake")
        .join("CMake")
        .join("bin")
        .join("cmake.exe")
}

/// Order installs newest-first, and identically on every machine.
///
/// Newest year wins; within a year the edition order above decides; an edition
/// nobody has heard of sorts after the known ones by name. Ties are broken by
/// path so the result is a total order with no dependence on directory order.
#[cfg(any(windows, test))]
fn sort_visual_studio_installs(installs: &mut [VisualStudioInstall]) {
    installs.sort_by(|left, right| {
        let rank = |edition: &str| {
            VISUAL_STUDIO_EDITIONS
                .iter()
                .position(|known| known.eq_ignore_ascii_case(edition))
                .unwrap_or(VISUAL_STUDIO_EDITIONS.len())
        };
        right
            .year
            .cmp(&left.year)
            .then_with(|| rank(&left.edition).cmp(&rank(&right.edition)))
            .then_with(|| left.edition.cmp(&right.edition))
            .then_with(|| left.cmake.cmp(&right.cmake))
    });
}

/// Collect the Visual Studio installs under one `Program Files` root.
#[cfg(windows)]
fn visual_studio_installs(root: &Path) -> Vec<VisualStudioInstall> {
    let mut installs = Vec::new();
    let Ok(years) = fs::read_dir(root.join("Microsoft Visual Studio")) else {
        return installs;
    };
    for year in years.flatten() {
        if !year.metadata().map(|meta| meta.is_dir()).unwrap_or(false) {
            continue;
        }
        // A non-numeric directory here is not a release year (VS also keeps
        // "Shared" beside them), so it cannot be ranked and is skipped.
        let Some(parsed) = year
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(editions) = fs::read_dir(year.path()) else {
            continue;
        };
        for edition in editions.flatten() {
            if !edition
                .metadata()
                .map(|meta| meta.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            installs.push(VisualStudioInstall {
                year: parsed,
                edition: edition.file_name().to_string_lossy().into_owned(),
                cmake: visual_studio_cmake(&edition.path()),
                edition_root: edition.path(),
            });
        }
    }
    installs
}

/// Where CMake is looked for on Windows when it is not on `PATH`, in the order
/// it is tried.
///
/// A standalone CMake install comes first: the user installed it deliberately
/// and it is almost always newer than whatever Visual Studio bundles. Visual
/// Studio's copies follow, newest release first.
#[cfg(windows)]
fn windows_cmake_candidates() -> Vec<PathBuf> {
    let roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"];
    let mut standalone = Vec::new();
    let mut installs = Vec::new();
    for variable in roots {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        standalone.push(root.join("CMake").join("bin").join("cmake.exe"));
        if variable == "LOCALAPPDATA" {
            standalone.push(
                root.join("Programs")
                    .join("CMake")
                    .join("bin")
                    .join("cmake.exe"),
            );
            continue;
        }
        installs.extend(visual_studio_installs(&root));
    }
    sort_visual_studio_installs(&mut installs);
    standalone
        .into_iter()
        .chain(installs.into_iter().map(|install| install.cmake))
        .collect()
}

#[cfg(windows)]
fn windows_cl_candidates() -> Vec<PathBuf> {
    let mut installs = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        installs.extend(visual_studio_installs(&root));
    }
    if let Some(root) = std::env::var_os("VSINSTALLDIR").map(PathBuf::from) {
        installs.push(VisualStudioInstall {
            // The process was explicitly launched from this developer
            // environment. Prefer its selected toolset over an arbitrary
            // installed edition, even when the directory name is not a
            // numeric Visual Studio release year.
            year: u32::MAX,
            edition: "DeveloperCommandPrompt".into(),
            cmake: PathBuf::new(),
            edition_root: root,
        });
    }
    sort_visual_studio_installs(&mut installs);

    let mut candidates = Vec::new();
    for install in installs {
        let msvc_root = install.edition_root.join("VC").join("Tools").join("MSVC");
        let Ok(versions) = fs::read_dir(msvc_root) else {
            continue;
        };
        let mut versions: Vec<PathBuf> = versions
            .flatten()
            .filter_map(|entry| {
                entry
                    .metadata()
                    .ok()
                    .filter(|meta| meta.is_dir())
                    .map(|_| entry.path())
            })
            .collect();
        versions.sort_by(|left, right| right.cmp(left));
        for version in versions {
            // Prefer a native x64 compiler, then fall back to the other host
            // and target combinations that Visual Studio installs.
            for (host, target) in [
                ("Hostx64", "x64"),
                ("Hostx86", "x64"),
                ("Hostx64", "x86"),
                ("Hostx86", "x86"),
            ] {
                candidates.push(version.join("bin").join(host).join(target).join("cl.exe"));
            }
        }
    }
    candidates
}

fn locate_tool(name: &str) -> Option<PathBuf> {
    let configured_name = match name {
        "cc" => Some("CC"),
        "c++" => Some("CXX"),
        "nvcc" => Some("CUDACXX"),
        _ => None,
    };
    if let Some(variable) = configured_name {
        if let Some(value) = std::env::var_os(variable) {
            let path = PathBuf::from(value);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    if let Ok(path) = which::which(name) {
        if path.is_file() {
            return Some(path);
        }
    }

    let root_variables: &[&str] = match name {
        "nvcc" => &["CUDA_PATH", "CUDA_HOME", "CUDA_TOOLKIT_ROOT_DIR"],
        "hipcc" => &["HIP_PATH", "ROCM_PATH"],
        "clang" | "clang++" => &["HIP_PATH", "ROCM_PATH"],
        "glslc" => &["VULKAN_SDK", "VK_SDK_PATH"],
        _ => &[],
    };
    for variable in root_variables {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        for relative in ["bin", ""] {
            let mut candidate = root.join(relative).join(name);
            #[cfg(windows)]
            if !candidate
                .extension()
                .is_some_and(|extension| extension == "exe")
            {
                candidate.set_extension("exe");
            }
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    #[cfg(windows)]
    if name.eq_ignore_ascii_case("cl") {
        return windows_cl_candidates()
            .into_iter()
            .find(|path| path.is_file());
    }

    None
}

/// Infer the SDK root from a compiler installed in `<root>/bin`. This keeps
/// standard ROCm/CUDA installations usable when their vendor installer did
/// not export HIP_PATH, ROCM_PATH, or CUDA_PATH (common on Unix systems).
fn sdk_root_from_tool(name: &str) -> Option<PathBuf> {
    let tool = locate_tool(name)?;
    let tool = fs::canonicalize(&tool).unwrap_or(tool);
    #[cfg(windows)]
    let tool = strip_windows_verbatim_prefix(tool);
    tool.parent()?.parent().map(Path::to_path_buf)
}

/// CMake's Windows Ninja generator invokes compiler and linker commands
/// through `cmd.exe`. The Win32 APIs accept `\\?\` extended paths, but cmd.exe
/// does not reliably execute them: it can compile a direct Ninja command and
/// then fail the link command with the unhelpful "path not found" message.
/// Never put such a path in PATH or a compiler variable handed to a child.
#[cfg(windows)]
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    const UNC_PREFIX: &str = "\\\\?\\UNC\\";
    const VERBATIM_PREFIX: &str = "\\\\?\\";
    if let Some(rest) = value.strip_prefix(UNC_PREFIX) {
        PathBuf::from(format!("\\\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(VERBATIM_PREFIX) {
        PathBuf::from(rest)
    } else {
        path
    }
}

/// A `hipcc` executable by itself is not an SDK. Distro packages sometimes
/// leave a wrapper at `/usr/bin/hipcc` even when the HIP headers and runtime
/// libraries are absent, so require an SDK marker before treating the inferred
/// parent as a usable ROCm installation.
fn rocm_sdk_root_has_runtime(root: &Path) -> bool {
    if root.join("include").join("hip").is_dir() {
        return true;
    }
    ["bin", "lib", "lib64", "lib/x64"].iter().any(|relative| {
        let Ok(entries) = fs::read_dir(root.join(relative)) else {
            return false;
        };
        entries.flatten().any(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
                && is_backend_runtime_library("rocm", &entry.file_name().to_string_lossy())
        })
    })
}

fn rocm_sdk_is_configured() -> bool {
    ["HIP_PATH", "ROCM_PATH"].iter().any(|variable| {
        std::env::var_os(variable)
            .map(PathBuf::from)
            .is_some_and(|root| root.is_dir() && rocm_sdk_root_has_runtime(&root))
    }) || sdk_root_from_tool("hipcc").is_some_and(|root| rocm_sdk_root_has_runtime(&root))
}

fn locate_cmake() -> Option<PathBuf> {
    if let Ok(path) = which::which("cmake") {
        if path.is_file() {
            return Some(path);
        }
    }

    #[cfg(windows)]
    {
        windows_cmake_candidates()
            .into_iter()
            .find(|path| path.is_file())
    }

    #[cfg(not(windows))]
    {
        None
    }
}

/// Name the places that were actually searched, per platform.
///
/// "the standard Windows install locations" is not advice on a Mac, and the
/// user's next move differs by platform, so say the platform's own.
fn cmake_not_found_error() -> String {
    let hint = if cfg!(windows) {
        "install it from cmake.org or with `winget install Kitware.CMake`, or add the C++ CMake tools to your Visual Studio install"
    } else if cfg!(target_os = "macos") {
        "install it with `brew install cmake`, or add the CMake app's bin directory to PATH"
    } else {
        "install it with your package manager, for example `apt install cmake ninja-build` or `dnf install cmake ninja-build`"
    };
    let searched = if cfg!(windows) {
        "PATH, the standard CMake install directories, and the copies bundled with Visual Studio"
    } else {
        "PATH"
    };
    format!(
        "CMake was not found. llama-board looked in {searched}. A PR build needs CMake and a C++ toolchain: {hint}, then try again."
    )
}

/// The oldest CMake that can run the command lines in this file.
///
/// Not llama.cpp's own floor - that is lower - but ours: `-S`/`-B` needs 3.13,
/// `--target a b` (llama-server *and* llama-bench in one build) needs 3.15,
/// and `CMAKE_CUDA_ARCHITECTURES` needs 3.18. A PR whose own
/// `cmake_minimum_required` is higher still fails at configure, and
/// `build_failure_hint` explains that case separately.
const MIN_CMAKE_VERSION: (u32, u32) = (3, 18);

/// Parse the first line of `cmake --version`, e.g.
/// `cmake version 3.29.2` or `cmake version 3.31.0-rc1`.
fn parse_cmake_version(text: &str) -> Option<(u32, u32, u32)> {
    let line = text.lines().find(|line| line.contains("cmake version"))?;
    let rest = line.split("cmake version").nth(1)?.trim();
    let number = rest
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .find(|part| !part.is_empty())?;
    let mut parts = number.split('.').map(|part| part.parse::<u32>().ok());
    let major = parts.next().flatten()?;
    let minor = parts.next().flatten().unwrap_or(0);
    let patch = parts.next().flatten().unwrap_or(0);
    Some((major, minor, patch))
}

fn cmake_version_error(path: &Path, version: (u32, u32, u32)) -> Option<String> {
    if (version.0, version.1) >= MIN_CMAKE_VERSION {
        return None;
    }
    Some(format!(
        "the CMake at {} is version {}.{}.{}, but a PR build needs at least {}.{}. Install a newer CMake (cmake.org, winget \"Kitware.CMake\", or the Visual Studio installer's C++ CMake tools) and try again.",
        path.display(),
        version.0,
        version.1,
        version.2,
        MIN_CMAKE_VERSION.0,
        MIN_CMAKE_VERSION.1
    ))
}

/// Run the located CMake once before anything is downloaded, so a toolchain
/// that cannot work says so in a second rather than after a source download.
async fn cmake_preflight(path: &Path) -> Result<(u32, u32, u32), String> {
    let probe = run_probe(path, &["--version"]).await;
    if !probe.success {
        let diagnostic = probe
            .diagnostic
            .unwrap_or_else(|| "it did not report a version".into());
        return Err(format!(
            "the CMake at {} could not be run: {diagnostic}. Check that the install is intact, or put a working cmake on PATH.",
            path.display()
        ));
    }
    let version = parse_cmake_version(&probe.text).ok_or_else(|| {
        format!(
            "the CMake at {} reported a version this build does not understand: {}",
            path.display(),
            probe.text.lines().next().unwrap_or("(no output)").trim()
        )
    })?;
    if let Some(error) = cmake_version_error(path, version) {
        return Err(error);
    }
    Ok(version)
}

/// Free bytes on the volume holding `path`, or `None` when the platform will
/// not say. A missing answer never blocks a build - it only means the early
/// warning cannot be given.
fn available_bytes(path: &Path) -> Option<u64> {
    // The deepest existing ancestor: the workspace directory itself may not
    // have been created yet when the check runs.
    let mut probe = path;
    loop {
        if probe.exists() {
            break;
        }
        probe = probe.parent()?;
    }
    platform_available_bytes(probe)
}

#[cfg(windows)]
fn platform_available_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_for_caller: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_for_caller,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free_for_caller)
}

#[cfg(unix)]
fn platform_available_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let raw = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(raw.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    // f_bavail is what an unprivileged process may actually use, which is the
    // number that matters here.
    (stats.f_bavail as u64).checked_mul(stats.f_frsize as u64)
}

#[cfg(not(any(windows, unix)))]
fn platform_available_bytes(_path: &Path) -> Option<u64> {
    None
}

const GIB: u64 = 1024 * 1024 * 1024;

/// Rough space a source build needs on the volume it runs on: the archive, the
/// extracted tree, and the object files, which dominate.
///
/// Deliberately an underestimate of a worst case rather than an overestimate:
/// this exists to catch "you have 2 GB free", not to argue with someone who
/// knows their own disk.
fn required_build_bytes(backend: &str) -> u64 {
    match backend {
        // Every CUDA kernel is compiled once per architecture in the list.
        "cuda" => 20 * GIB,
        _ => 10 * GIB,
    }
}

/// Space the *installed* runtime needs, which is a different volume whenever
/// the runtimes directory and the download directory are not on the same
/// drive. The staged copy and the outgoing backup coexist for the length of
/// one rename, so budget for two.
const INSTALLED_RUNTIME_BYTES: u64 = 4 * GIB;

/// A directory-name nonce short enough not to eat the Windows path budget.
///
/// 12 hex characters is 48 bits. These names only have to be unique among the
/// installs running on one machine at one moment - the runtime busy guard
/// means that is normally one - so this is collisions-never territory while
/// costing 20 fewer characters than a full UUID on every path beneath it.
fn short_nonce() -> String {
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn free_space_error(
    label: &str,
    path: &Path,
    required: u64,
    available: Option<u64>,
) -> Option<String> {
    let available = available?;
    if available >= required {
        return None;
    }
    let gib = |bytes: u64| format!("{:.1} GB", bytes as f64 / GIB as f64);
    Some(format!(
        "not enough free disk space for the {label}: it needs about {}, but only {} is free on {}. Free some space, or move the llama-board data directory to a larger drive, then try again.",
        gib(required),
        gib(available),
        path.display()
    ))
}

struct ProbeCommand {
    success: bool,
    text: String,
    diagnostic: Option<String>,
}

/// Which end of an over-long stream to keep once the cap is reached.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Retain {
    /// Version banners and `--help` output are parsed from the front.
    Head,
    /// Build logs are only ever read to find out what failed at the end.
    Tail,
}

/// A drain buffer both the reader task and its supervisor can see.
///
/// A reader that has to be abandoned at its join deadline still holds the only
/// copy of what it read; sharing the buffer means the supervisor can recover
/// that tail instead of reporting a failed build with no diagnostic at all.
type SharedLog = Arc<std::sync::Mutex<Vec<u8>>>;

fn shared_log() -> SharedLog {
    Arc::new(std::sync::Mutex::new(Vec::new()))
}

/// Read the shared buffer, tolerating a poisoned lock: a partial log is still
/// worth more to the user than nothing.
fn read_log(log: &SharedLog) -> Vec<u8> {
    log.lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

/// Read `reader` to EOF while keeping at most `cap` bytes of it.
///
/// The stream is drained even after the cap is reached. Returning early would
/// drop the pipe handle while the child is still writing, and the child would
/// then die on a broken pipe - or, once the OS pipe buffer filled, block
/// forever - instead of finishing its build.
async fn drain_stream_into<R>(mut reader: R, log: SharedLog, cap: usize, retain: Retain)
where
    R: AsyncRead + Unpin,
{
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(read) => read,
            // A closed or broken pipe is the end of this stream, not a reason
            // to leave the remaining handle dangling.
            Err(_) => break,
        };
        let bytes = &chunk[..read];
        // The guard never spans an await, so an abort at the deadline above
        // cannot strand it; the poison branch is belt and braces.
        let mut retained = log.lock().unwrap_or_else(|error| error.into_inner());
        match retain {
            Retain::Head => {
                if retained.len() < cap {
                    let room = cap - retained.len();
                    retained.extend_from_slice(&bytes[..room.min(bytes.len())]);
                }
            }
            Retain::Tail => {
                if bytes.len() >= cap {
                    retained.clear();
                    retained.extend_from_slice(&bytes[bytes.len() - cap..]);
                } else {
                    retained.extend_from_slice(bytes);
                    if retained.len() > cap {
                        let excess = retained.len() - cap;
                        retained.drain(..excess);
                    }
                }
            }
        }
    }
}

async fn drain_stream<R>(reader: R, cap: usize, retain: Retain) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    let log = shared_log();
    drain_stream_into(reader, log.clone(), cap, retain).await;
    read_log(&log)
}

async fn read_probe_output<R>(reader: R) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    drain_stream(reader, MAX_PROBE_OUTPUT, Retain::Head).await
}

async fn finish_reader(mut task: JoinHandle<Vec<u8>>, limit: Duration) -> Vec<u8> {
    match timeout(limit, &mut task).await {
        Ok(Ok(output)) => output,
        _ => {
            task.abort();
            let _ = task.await;
            Vec::new()
        }
    }
}

async fn finish_probe_reader(task: JoinHandle<Vec<u8>>) -> Vec<u8> {
    finish_reader(task, PROBE_READER_TIMEOUT).await
}

/// Join a build drain task, and if it will not end - a grandchild is still
/// holding the inherited pipe - abandon it but keep whatever it already read.
async fn finish_build_reader(
    mut task: JoinHandle<()>,
    log: &SharedLog,
    limit: Duration,
) -> Vec<u8> {
    if timeout(limit, &mut task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
    read_log(log)
}

async fn terminate_probe(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .env_clear()
            .envs(child_environment())
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Put every CMake configure/build child in a private process group on Unix.
/// A CMake generator starts a compiler process (and often another wrapper)
/// beneath it; killing only the direct child leaves that grandchild compiling
/// against a tree that cleanup is about to remove.
fn configure_build_process_group(command: &mut Command) {
    #[cfg(not(unix))]
    let _ = command;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // `setpgid(0, 0)` makes the child the leader of a new group. The
        // closure runs in the child between fork and exec, before any build
        // code can spawn descendants.
        unsafe {
            command.as_std_mut().pre_exec(|| {
                if libc::setpgid(0, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
}

/// PIDs of the top-level CMake processes currently owned by a source build.
///
/// The async cancellation path can kill a process tree while the app is alive,
/// but a window close can terminate the Rust future before it gets a chance to
/// observe `runtime_cancel`. Keeping only these short-lived top-level PIDs lets
/// the exit handler kill the whole tree synchronously, without holding a lock
/// across the build itself.
static ACTIVE_BUILD_PIDS: OnceLock<Mutex<Vec<u32>>> = OnceLock::new();
static BUILD_SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

fn active_build_pids() -> &'static Mutex<Vec<u32>> {
    ACTIVE_BUILD_PIDS.get_or_init(|| Mutex::new(Vec::new()))
}

fn terminate_build_pid_sync(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .env_clear()
            .envs(child_environment())
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(unix)]
    {
        unsafe {
            let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
}

fn register_active_build(pid: u32) {
    let kill_now = {
        let Ok(mut active) = active_build_pids().lock() else {
            return;
        };
        if BUILD_SHUTDOWN_REQUESTED.load(Ordering::Acquire) {
            true
        } else {
            active.push(pid);
            false
        }
    };
    if kill_now {
        terminate_build_pid_sync(pid);
    }
}

fn unregister_active_build(pid: u32) {
    if let Ok(mut active) = active_build_pids().lock() {
        active.retain(|candidate| *candidate != pid);
    }
}

/// Request termination of every in-flight source build. This is intentionally
/// synchronous: it runs from Tauri's exit callback, after the app has stopped
/// accepting work, and must finish before the process disappears.
pub fn terminate_active_builds() {
    BUILD_SHUTDOWN_REQUESTED.store(true, Ordering::Release);
    let pids = active_build_pids()
        .lock()
        .map(|mut active| std::mem::take(&mut *active))
        .unwrap_or_default();
    for pid in pids {
        terminate_build_pid_sync(pid);
    }
}

/// Terminate a build process and all descendants. Windows keeps the existing
/// taskkill tree termination; Unix sends SIGKILL to the private process group.
async fn terminate_build_child(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let process_group = -(pid as libc::pid_t);
        unsafe {
            let _ = libc::kill(process_group, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .env_clear()
            .envs(child_environment())
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn run_probe(binary: &Path, args: &[&str]) -> ProbeCommand {
    run_probe_with(binary, args, PROBE_TIMEOUT).await
}

enum ProbeWaitOutcome {
    Exited(Result<std::process::ExitStatus, String>),
    Cancelled,
    TimedOut,
}

async fn wait_probe_child(
    child: &mut tokio::process::Child,
    limit: Duration,
    cancel: Option<&Arc<AtomicBool>>,
) -> ProbeWaitOutcome {
    match cancel {
        None => match timeout(limit, child.wait()).await {
            Ok(Ok(status)) => ProbeWaitOutcome::Exited(Ok(status)),
            Ok(Err(error)) => ProbeWaitOutcome::Exited(Err(error.to_string())),
            Err(_) => ProbeWaitOutcome::TimedOut,
        },
        Some(cancel) => {
            let wait = async {
                loop {
                    tokio::select! {
                        result = child.wait() => {
                            return ProbeWaitOutcome::Exited(result.map_err(|error| error.to_string()));
                        }
                        _ = sleep(Duration::from_millis(100)) => {
                            if cancel.load(Ordering::Acquire) {
                                return ProbeWaitOutcome::Cancelled;
                            }
                        }
                    }
                }
            };
            match timeout(limit, wait).await {
                Ok(outcome) => outcome,
                Err(_) => ProbeWaitOutcome::TimedOut,
            }
        }
    }
}

async fn run_probe_with(binary: &Path, args: &[&str], limit: Duration) -> ProbeCommand {
    run_probe_with_cancel(binary, args, limit, None).await
}

async fn run_probe_with_cancel(
    binary: &Path,
    args: &[&str],
    limit: Duration,
    cancel: Option<&Arc<AtomicBool>>,
) -> ProbeCommand {
    let environment = child_environment();
    run_probe_with_cancel_and_environment(binary, args, limit, cancel, &environment).await
}

async fn run_probe_with_cancel_and_environment(
    binary: &Path,
    args: &[&str],
    limit: Duration,
    cancel: Option<&Arc<AtomicBool>>,
    environment: &[(OsString, OsString)],
) -> ProbeCommand {
    let mut command = Command::new(binary);
    command
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)));
    let mut child = match command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return ProbeCommand {
                success: false,
                text: String::new(),
                diagnostic: Some(format!("cannot run {}: {error}", args.join(" "))),
            };
        }
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_probe(&mut child).await;
        return ProbeCommand {
            success: false,
            text: String::new(),
            diagnostic: Some("runtime probe stdout was not captured".into()),
        };
    };
    let stdout_task = tokio::spawn(read_probe_output(stdout));
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| tokio::spawn(read_probe_output(stderr)));
    let status = match wait_probe_child(&mut child, limit, cancel).await {
        ProbeWaitOutcome::Exited(Ok(status)) => status,
        ProbeWaitOutcome::Exited(Err(error)) => {
            terminate_probe(&mut child).await;
            let _ = finish_probe_reader(stdout_task).await;
            if let Some(task) = stderr_task {
                let _ = finish_probe_reader(task).await;
            }
            return ProbeCommand {
                success: false,
                text: String::new(),
                diagnostic: Some(format!("runtime probe wait failed: {error}")),
            };
        }
        ProbeWaitOutcome::Cancelled => {
            terminate_probe(&mut child).await;
            let _ = finish_probe_reader(stdout_task).await;
            if let Some(task) = stderr_task {
                let _ = finish_probe_reader(task).await;
            }
            return ProbeCommand {
                success: false,
                text: String::new(),
                diagnostic: Some("runtime install cancelled".into()),
            };
        }
        ProbeWaitOutcome::TimedOut => {
            terminate_probe(&mut child).await;
            let _ = finish_probe_reader(stdout_task).await;
            if let Some(task) = stderr_task {
                let _ = finish_probe_reader(task).await;
            }
            return ProbeCommand {
                success: false,
                text: String::new(),
                diagnostic: Some(format!(
                    "runtime probe timed out after {}s: {}",
                    limit.as_secs(),
                    args.join(" ")
                )),
            };
        }
    };
    let stdout = finish_probe_reader(stdout_task).await;
    let stderr = match stderr_task {
        Some(task) => finish_probe_reader(task).await,
        None => Vec::new(),
    };
    let mut combined = String::from_utf8_lossy(&stdout).into_owned();
    let stderr_text = String::from_utf8_lossy(&stderr);
    if !stderr_text.trim().is_empty() {
        combined.push('\n');
        combined.push_str(stderr_text.trim());
    }
    ProbeCommand {
        success: status.success(),
        text: combined,
        diagnostic: (!status.success())
            .then(|| format!("runtime probe exited with {status}: {}", args.join(" "))),
    }
}

fn probe_flags(help: &str) -> Vec<String> {
    let mut flags = Vec::new();
    for token in help.split_whitespace() {
        let flag = token
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '-');
        if !flag.starts_with("--")
            || flag.len() < 3
            || !flag[2..]
                .chars()
                .any(|character| character.is_ascii_alphanumeric())
            || flags.iter().any(|item| item == flag)
        {
            continue;
        }
        flags.push(flag.to_string());
        if flags.len() >= 500 {
            break;
        }
    }
    flags
}

fn probe_devices(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(100)
        .map(str::to_string)
        .collect()
}

fn classify_preflight(version: bool, help: bool, devices: bool, bench: bool) -> &'static str {
    if version && help && devices && bench {
        "available"
    } else {
        "failed preflight"
    }
}

pub async fn probe(backend: &str, build: &str) -> Result<RuntimeCapabilities, String> {
    let (resolved_backend, resolved_build, binary) = if backend.is_empty() && build.is_empty() {
        let binary = which::which(server_executable_name())
            .map_err(|_| "no llama-server executable was found on PATH".to_string())?;
        ("system".to_string(), "system".to_string(), binary)
    } else {
        validate_runtime_identifiers(backend, build)?;
        let binary = server_bin_for(backend, build)?;
        (backend.to_string(), build.to_string(), binary)
    };
    if !binary.is_file() {
        return Ok(RuntimeCapabilities {
            backend: resolved_backend,
            build: resolved_build,
            executable: binary.to_string_lossy().into_owned(),
            state: "not installed".into(),
            version: String::new(),
            flags: Vec::new(),
            devices: Vec::new(),
            diagnostics: vec!["llama-server executable is missing".into()],
            bench_available: false,
        });
    }
    let environment = if backend.is_empty() && build.is_empty() {
        child_environment()
    } else {
        child_environment_for_runtime(backend, build)?
    };
    let dependency_error = if !backend.is_empty()
        && matches!(backend, "cuda" | "rocm")
        && binary
            .parent()
            .is_some_and(|directory| !backend_runtime_dependencies_complete(backend, directory))
    {
        Some(format!(
            "the installed {backend} runtime is missing its bundled vendor libraries or kernel data. Reinstall or import this runtime so it does not depend on a host SDK."
        ))
    } else {
        None
    };
    let version = run_probe_with_cancel_and_environment(
        &binary,
        &["--version"],
        PROBE_TIMEOUT,
        None,
        &environment,
    )
    .await;
    // Backfill the manifest for runtimes installed before it existed, so the
    // list stops showing a bare build tag once the user probes them.
    if version.success && !backend.is_empty() && !build.is_empty() {
        if let (Some(parsed), Some(dir)) = (parse_runtime_version(&version.text), binary.parent()) {
            if read_version_manifest(dir).as_ref() != Some(&parsed) {
                write_version_manifest(dir, &parsed);
            }
        }
    }
    let help = run_probe_with_cancel_and_environment(
        &binary,
        &["--help"],
        PROBE_TIMEOUT,
        None,
        &environment,
    )
    .await;
    let devices = run_probe_with_cancel_and_environment(
        &binary,
        &["--list-devices"],
        PROBE_TIMEOUT,
        None,
        &environment,
    )
    .await;
    let bench_binary = if backend.is_empty() && build.is_empty() {
        which::which(bench_executable_name()).ok().or_else(|| {
            binary
                .parent()
                .map(|parent| parent.join(bench_executable_name()))
                .filter(|path| path.is_file())
        })
    } else {
        Some(bench_bin_for(backend, build)?)
    };
    let bench = match bench_binary {
        Some(path) if path.is_file() => {
            run_probe_with_cancel_and_environment(
                &path,
                &["--help"],
                PROBE_TIMEOUT,
                None,
                &environment,
            )
            .await
        }
        Some(path) => ProbeCommand {
            success: false,
            text: String::new(),
            diagnostic: Some(format!(
                "llama-bench executable is missing: {}",
                path.display()
            )),
        },
        None => ProbeCommand {
            success: false,
            text: String::new(),
            diagnostic: Some("llama-bench executable was not found on PATH".into()),
        },
    };
    let mut diagnostics = Vec::new();
    if let Some(error) = dependency_error.as_ref() {
        diagnostics.push(error.clone());
    }
    for result in [&version, &help, &devices, &bench] {
        if let Some(diagnostic) = &result.diagnostic {
            diagnostics.push(diagnostic.clone());
        }
    }
    let state = if dependency_error.is_some() {
        "failed preflight"
    } else {
        classify_preflight(
            version.success,
            help.success,
            devices.success,
            bench.success,
        )
    };
    Ok(RuntimeCapabilities {
        backend: resolved_backend,
        build: resolved_build,
        executable: binary.to_string_lossy().into_owned(),
        state: state.into(),
        version: version.text.chars().take(4096).collect(),
        flags: probe_flags(&help.text),
        devices: probe_devices(&devices.text),
        diagnostics,
        bench_available: bench.success,
    })
}

pub fn system_server_fallback(local_app_data: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(local_app_data)
            .join("Microsoft")
            .join("WinGet")
            .join("Packages")
            .join("ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join(server_executable_name())
    } else {
        PathBuf::from(server_executable_name())
    }
}

pub fn list_installed() -> Vec<InstalledRuntime> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(runtimes_root()) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((build, backend)) = name.split_once('-') else {
            continue;
        };
        if validate_runtime_identifiers(backend, build).is_err() {
            continue;
        }
        let dir = entry.path();
        if !dir.join(server_executable_name()).is_file()
            || !dir.join(bench_executable_name()).is_file()
        {
            continue;
        }
        out.push(InstalledRuntime {
            build: build.into(),
            backend: backend.into(),
            dir: dir.to_string_lossy().to_string(),
            size_mb: dir_size(&dir),
            version: read_version_manifest(&dir),
            source: read_source_manifest(&dir),
            replaced: None,
        });
    }
    out.sort_by(|a, b| b.build.cmp(&a.build).then(a.backend.cmp(&b.backend)));
    out
}

fn dir_size(dir: &Path) -> f64 {
    dir_size_bytes(dir) as f64 / 1_048_576.0
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0_u64;
    walk_size(dir, &mut total, 0);
    total
}

fn walk_size(dir: &Path, total: &mut u64, depth: u32) {
    if depth > 32 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            walk_size(&path, total, depth + 1);
        } else {
            *total = total.saturating_add(metadata.len());
        }
    }
}

fn bundle_architecture() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

fn bundle_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "runtime bundle file escaped its runtime directory".to_string())?;
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err("runtime bundle contains an invalid relative path".into());
        };
        let component = component
            .to_str()
            .ok_or_else(|| "runtime bundle contains a non-UTF-8 filename".to_string())?;
        if component.is_empty() || component.contains(['/', '\\']) {
            return Err("runtime bundle contains an invalid filename".into());
        }
        components.push(component);
    }
    if components.is_empty() {
        return Err("runtime bundle contains an empty relative path".into());
    }
    Ok(components.join("/"))
}

fn validate_bundle_manifest_path(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 1024 || value.contains(['\\', '\0', ':']) {
        return Err("runtime bundle manifest contains an invalid relative path".into());
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err("runtime bundle manifest contains an absolute path".into());
    }
    let mut components = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err("runtime bundle manifest contains an invalid relative path".into());
        };
        let component = component
            .to_str()
            .ok_or_else(|| "runtime bundle manifest contains a non-UTF-8 path".to_string())?;
        if component.is_empty() {
            return Err("runtime bundle manifest contains an empty path component".into());
        }
        components.push(component);
    }
    if components.is_empty() || components.join("/") != value {
        return Err("runtime bundle manifest path must use normalized POSIX separators".into());
    }
    Ok(())
}

fn collect_runtime_files_recursive(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf, u64)>,
    depth: u32,
) -> Result<(), String> {
    if depth > 64 {
        return Err("runtime bundle directory nesting is too deep".into());
    }
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "runtime bundle cannot contain a symbolic link: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            collect_runtime_files_recursive(root, &path, files, depth + 1)?;
        } else if metadata.is_file() {
            let relative = bundle_relative_path(root, &path)?;
            if relative == RUNTIME_BUNDLE_MANIFEST {
                continue;
            }
            files.push((relative, path, metadata.len()));
        } else {
            return Err(format!(
                "runtime bundle contains an unsupported filesystem entry: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn collect_runtime_files(root: &Path) -> Result<Vec<(String, PathBuf, u64)>, String> {
    let mut files = Vec::new();
    collect_runtime_files_recursive(root, root, &mut files, 0)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn validate_bundle_manifest(manifest: &RuntimeBundleManifest) -> Result<(), String> {
    if manifest.format != RUNTIME_BUNDLE_FORMAT {
        return Err(format!(
            "unsupported runtime bundle format: {}",
            manifest.format
        ));
    }
    validate_runtime_identifiers(&manifest.backend, &manifest.build)?;
    if manifest.platform != release_platform() {
        return Err(format!(
            "runtime bundle targets {}, but this app runs on {}",
            manifest.platform,
            release_platform()
        ));
    }
    if manifest.architecture != bundle_architecture() {
        return Err(format!(
            "runtime bundle targets {}, but this app runs on {}",
            manifest.architecture,
            bundle_architecture()
        ));
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_ARCHIVE_ENTRIES {
        return Err("runtime bundle has an invalid file list".into());
    }
    let mut previous = None;
    for file in &manifest.files {
        validate_bundle_manifest_path(&file.path)?;
        normalize_digest(&file.sha256)?;
        if previous.is_some_and(|value: &str| value >= file.path.as_str()) {
            return Err("runtime bundle manifest file list is not sorted".into());
        }
        previous = Some(file.path.as_str());
    }
    if manifest.build.starts_with("pr") {
        let source = manifest
            .source
            .as_ref()
            .ok_or("PR runtime bundle has no source provenance manifest")?;
        let expected = manifest.build[2..]
            .parse::<u64>()
            .map_err(|_| "PR runtime bundle has an invalid pull request build id")?;
        if source.pull_request != expected {
            return Err("PR runtime bundle provenance does not match its build id".into());
        }
        validate_commit_sha(&source.commit)?;
    }
    Ok(())
}

fn read_bundle_manifest(root: &Path) -> Result<RuntimeBundleManifest, String> {
    let path = root.join(RUNTIME_BUNDLE_MANIFEST);
    let metadata = fs::metadata(&path)
        .map_err(|_| "runtime bundle is missing llama-board-runtime-bundle.json".to_string())?;
    if metadata.len() > 2 * 1024 * 1024 {
        return Err("runtime bundle manifest is too large".into());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let manifest: RuntimeBundleManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("runtime bundle manifest is invalid JSON: {error}"))?;
    validate_bundle_manifest(&manifest)?;
    Ok(manifest)
}

fn find_bundle_runtime_root(extracted: &Path) -> Result<PathBuf, String> {
    let entries = fs::read_dir(extracted).map_err(|error| error.to_string())?;
    let mut roots = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("runtime bundle contains a symbolic link".into());
        }
        if !metadata.is_dir() {
            return Err("runtime bundle must contain one runtime directory".into());
        }
        roots.push(entry.path());
    }
    match roots.as_slice() {
        [root] => Ok(root.clone()),
        [] => Err("runtime bundle has no runtime directory".into()),
        _ => Err("runtime bundle has multiple top-level directories".into()),
    }
}

fn verify_bundle_files(root: &Path, manifest: &RuntimeBundleManifest) -> Result<(), String> {
    let actual = collect_runtime_files(root)?;
    if actual.len() != manifest.files.len() {
        return Err(format!(
            "runtime bundle file list mismatch: manifest has {}, archive has {}",
            manifest.files.len(),
            actual.len()
        ));
    }
    for ((actual_path, path, actual_bytes), declared) in actual.iter().zip(&manifest.files) {
        if actual_path != &declared.path || actual_bytes != &declared.bytes {
            return Err(format!(
                "runtime bundle file metadata mismatch for {}",
                declared.path
            ));
        }
        let actual_hash = sha256_file(path)?;
        if actual_hash != declared.sha256 {
            return Err(format!(
                "runtime bundle file digest mismatch for {}",
                declared.path
            ));
        }
    }
    if read_source_manifest(root) != manifest.source {
        return Err("runtime bundle source provenance does not match its manifest".into());
    }
    if read_version_manifest(root) != manifest.version {
        return Err("runtime bundle version manifest does not match its manifest".into());
    }
    verify_runtime_files(root)
}

fn bundle_sidecar_path(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("runtime.zip");
    output.with_file_name(format!("{name}.sha256"))
}

fn verify_optional_bundle_sidecar(archive: &Path) -> Result<(), String> {
    let sidecar = bundle_sidecar_path(archive);
    let metadata = match fs::metadata(&sidecar) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "cannot inspect runtime bundle checksum {}: {error}",
                sidecar.display()
            ));
        }
    };
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err("runtime bundle checksum sidecar is invalid".into());
    }
    let text = fs::read_to_string(&sidecar)
        .map_err(|error| format!("cannot read runtime bundle checksum: {error}"))?;
    let mut fields = text.split_whitespace();
    let expected = normalize_digest(fields.next().ok_or("runtime bundle checksum is empty")?)?;
    let expected_name = fields
        .next()
        .ok_or("runtime bundle checksum has no filename")?
        .trim_start_matches('*');
    let actual_name = archive
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("runtime bundle archive has no valid filename")?;
    if expected_name != actual_name || fields.next().is_some() {
        return Err("runtime bundle checksum filename does not match the archive".into());
    }
    let actual = sha256_file(archive)?;
    if actual != expected {
        return Err(format!(
            "runtime bundle checksum mismatch: expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

/// Make a disposable export snapshot when the platform needs extra files. A
/// runtime built by an older llama-board may contain the GPU DLLs but not the
/// SDK's data files, and a normal Windows target may not contain the MSVC CRT.
/// Keeping the snapshot outside the installed directory means export never
/// mutates or silently upgrades the runtime the user is currently using.
fn prepare_export_root(
    root: &Path,
    backend: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<PathBuf>, String> {
    if !cfg!(windows) && !matches!(backend, "cuda" | "rocm") {
        return Ok(None);
    }
    let snapshot = runtimes_root().join(format!(".runtime-export-{}", short_nonce()));
    let result = (|| -> Result<(), String> {
        fs::create_dir_all(&snapshot).map_err(|error| error.to_string())?;
        copy_runtime_tree(root, &snapshot, cancel)?;
        copy_backend_runtime_dependencies(backend, &snapshot, cancel)?;
        copy_msvc_runtime_dependencies(&snapshot, cancel)?;
        verify_runtime_files(&snapshot)
    })();
    match result {
        Ok(()) => Ok(Some(snapshot)),
        Err(error) => {
            let _ = remove_tree_bounded(&snapshot);
            Err(error)
        }
    }
}

struct ExportSnapshot(Option<PathBuf>);

impl ExportSnapshot {
    fn root<'a>(&'a self, installed: &'a Path) -> &'a Path {
        self.0.as_deref().unwrap_or(installed)
    }
}

impl Drop for ExportSnapshot {
    fn drop(&mut self) {
        if let Some(snapshot) = self.0.take() {
            let _ = remove_tree_bounded(&snapshot);
        }
    }
}

/// Write an installed runtime as a self-contained archive that can be moved to
/// a PC with no build tools. The caller runs this blocking function on the
/// Tokio blocking pool because vendor runtime bundles can be several GB.
pub fn export_bundle(
    output: &Path,
    backend: &str,
    build: &str,
    progress: ProgressSink<'_>,
    cancel: &Arc<AtomicBool>,
) -> Result<RuntimeBundleInfo, String> {
    validate_runtime_identifiers(backend, build)?;
    let root = runtime_dir(backend, build)?;
    if !root.is_dir() {
        return Err("the selected runtime is not installed".into());
    }
    let output = output.to_path_buf();
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("cannot resolve runtime directory: {error}"))?;
    let output_parent = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(output_parent).map_err(|error| error.to_string())?;
    let canonical_parent = output_parent
        .canonicalize()
        .map_err(|error| format!("cannot resolve export directory: {error}"))?;
    if canonical_parent.starts_with(&canonical_root) {
        return Err("choose an export location outside the installed runtime directory".into());
    }
    let runtime_bytes = dir_size_bytes(&root);
    let export_required = runtime_bytes
        .saturating_mul(2)
        .saturating_add(512 * 1024 * 1024);
    if let Some(error) = free_space_error(
        "runtime export",
        &canonical_parent,
        export_required,
        available_bytes(&canonical_parent),
    ) {
        return Err(error);
    }
    let snapshot_parent = runtimes_root();
    if let Some(error) = free_space_error(
        "runtime export snapshot",
        &snapshot_parent,
        export_required,
        available_bytes(&snapshot_parent),
    ) {
        return Err(error);
    }
    let snapshot = ExportSnapshot(prepare_export_root(&root, backend, cancel)?);
    let export_root = snapshot.root(&root);
    let files = collect_runtime_files(export_root)?;
    if files.is_empty() {
        return Err("cannot export an empty runtime".into());
    }
    let total_bytes = files.iter().map(|(_, _, bytes)| *bytes).sum::<u64>();
    if total_bytes > MAX_EXTRACTED_BYTES {
        return Err("runtime is too large to fit the configured portable bundle limit".into());
    }
    verify_runtime_files(export_root)?;
    let file_manifest = files
        .iter()
        .map(|(path, file, bytes)| {
            Ok(RuntimeBundleFile {
                path: path.clone(),
                bytes: *bytes,
                sha256: sha256_file(file)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let manifest = RuntimeBundleManifest {
        format: RUNTIME_BUNDLE_FORMAT,
        backend: backend.into(),
        build: build.into(),
        platform: release_platform().into(),
        architecture: bundle_architecture().into(),
        version: read_version_manifest(export_root),
        source: read_source_manifest(export_root),
        files: file_manifest,
    };
    validate_bundle_manifest(&manifest)?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("failed to encode runtime bundle manifest: {error}"))?;
    let root_name = format!("{build}-{backend}");
    let output_name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("export path has no valid filename")?;
    if !output_name.to_ascii_lowercase().ends_with(".zip") {
        return Err("runtime export must use a .zip filename".into());
    }
    let temp = output_parent.join(format!(".{output_name}.part-{}", short_nonce()));
    let result = (|| -> Result<RuntimeBundleInfo, String> {
        let file = fs::File::create(&temp).map_err(|error| error.to_string())?;
        let mut archive = zip::ZipWriter::new(file);
        let mut copied_bytes = 0_u64;
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        archive
            .add_directory(format!("{root_name}/"), options)
            .map_err(|error| error.to_string())?;
        for (relative, path, declared_bytes) in &files {
            if cancel.load(Ordering::Acquire) {
                return Err("runtime install cancelled".into());
            }
            archive
                .start_file(format!("{root_name}/{relative}"), options)
                .map_err(|error| error.to_string())?;
            let mut source = fs::File::open(path).map_err(|error| error.to_string())?;
            let mut buffer = [0_u8; 1024 * 1024];
            let mut file_bytes = 0_u64;
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err("runtime install cancelled".into());
                }
                let read = std::io::Read::read(&mut source, &mut buffer)
                    .map_err(|error| error.to_string())?;
                if read == 0 {
                    break;
                }
                std::io::Write::write_all(&mut archive, &buffer[..read])
                    .map_err(|error| error.to_string())?;
                file_bytes = file_bytes.saturating_add(read as u64);
                copied_bytes = copied_bytes.saturating_add(read as u64);
                progress("packaging", copied_bytes as f64, total_bytes as f64);
            }
            if file_bytes != *declared_bytes {
                return Err(format!("runtime file changed while exporting: {relative}"));
            }
        }
        archive
            .start_file(format!("{root_name}/{RUNTIME_BUNDLE_MANIFEST}"), options)
            .map_err(|error| error.to_string())?;
        std::io::Write::write_all(&mut archive, &manifest_bytes)
            .map_err(|error| error.to_string())?;
        archive.finish().map_err(|error| error.to_string())?;
        let bytes = fs::metadata(&temp)
            .map_err(|error| error.to_string())?
            .len();
        if bytes > MAX_ARCHIVE_BYTES {
            return Err("exported runtime bundle exceeds the configured archive size limit".into());
        }
        let archive_sha256 = sha256_file(&temp)?;
        if output.is_dir() {
            return Err(format!("export path is a directory: {}", output.display()));
        }
        let backup = if output.exists() {
            let backup = output_parent.join(format!(".{output_name}.backup-{}", short_nonce()));
            fs::rename(&output, &backup)
                .map_err(|error| format!("failed to replace existing export: {error}"))?;
            Some(backup)
        } else {
            None
        };
        if let Err(error) = fs::rename(&temp, &output) {
            if let Some(backup) = backup.as_ref() {
                let _ = fs::rename(backup, &output);
            }
            return Err(error.to_string());
        }
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
        let sidecar = bundle_sidecar_path(&output);
        fs::write(&sidecar, format!("{archive_sha256}  {output_name}\n"))
            .map_err(|error| format!("failed to write export checksum: {error}"))?;
        progress("installed", bytes as f64, bytes as f64);
        Ok(RuntimeBundleInfo {
            path: output.to_string_lossy().into_owned(),
            backend: backend.into(),
            build: build.into(),
            archive_sha256,
            bytes,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

async fn remove_import_staging(staging: &Path) {
    let staging = staging.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || remove_tree_bounded(&staging)).await;
}

/// Import a bundle produced by export_bundle. The input archive is never
/// deleted or modified; only the private staging directory is cleaned up on
/// failure. No local compiler, CMake, or vendor SDK is consulted here.
pub async fn import_bundle(
    archive: &Path,
    progress: ProgressSink<'_>,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, String> {
    import_bundle_with_digest(archive, None, None, None, progress, cancel).await
}

async fn import_bundle_with_digest(
    archive: &Path,
    expected_archive_sha256: Option<&str>,
    expected_backend: Option<&str>,
    expected_source: Option<&RuntimeSource>,
    progress: ProgressSink<'_>,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, String> {
    let archive = archive.to_path_buf();
    let expected_archive_sha256 = expected_archive_sha256.map(normalize_digest).transpose()?;
    let metadata = tokio::task::spawn_blocking({
        let archive = archive.clone();
        move || fs::metadata(&archive).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("runtime bundle metadata task failed: {error}"))??;
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err("runtime bundle exceeds the configured archive size limit".into());
    }
    if !metadata.is_file() {
        return Err("runtime bundle path is not a file".into());
    }
    let sidecar_path = archive.clone();
    tokio::task::spawn_blocking(move || verify_optional_bundle_sidecar(&sidecar_path))
        .await
        .map_err(|error| format!("runtime bundle checksum task failed: {error}"))??;
    if let Some(expected) = expected_archive_sha256 {
        let hash_path = archive.clone();
        let actual = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
            .await
            .map_err(|error| format!("runtime bundle hash task failed: {error}"))??;
        if actual != expected {
            return Err(format!(
                "prebuilt PR artifact digest mismatch: expected {expected}, got {actual}"
            ));
        }
    }
    let root = runtimes_root();
    tokio::task::spawn_blocking({
        let root = root.clone();
        move || fs::create_dir_all(root).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("runtime bundle directory task failed: {error}"))??;
    let staging = root.join(format!(".runtime-import-{}", short_nonce()));
    progress("extracting", 0.0, metadata.len() as f64);
    let extracted = staging.clone();
    let extract_archive = archive.clone();
    let extract_cancel = cancel.clone();
    let expected_backend = expected_backend.map(str::to_owned);
    let expected_source = expected_source.cloned();
    let verified = match tokio::task::spawn_blocking(move || {
        extract(&extract_archive, &extracted, &extract_cancel)?;
        let runtime_root = find_bundle_runtime_root(&extracted)?;
        let manifest = read_bundle_manifest(&runtime_root)?;
        let expected_name = format!("{}-{}", manifest.build, manifest.backend);
        if runtime_root.file_name().and_then(|value| value.to_str()) != Some(&expected_name) {
            return Err("runtime bundle directory does not match its manifest".into());
        }
        verify_bundle_files(&runtime_root, &manifest)?;
        if let Some(expected) = expected_backend {
            if manifest.backend != expected {
                return Err(format!(
                    "prebuilt PR artifact targets backend {}, not {}",
                    manifest.backend, expected
                ));
            }
        }
        if let Some(expected) = expected_source.as_ref() {
            let actual = manifest
                .source
                .as_ref()
                .ok_or("prebuilt PR artifact has no source provenance manifest")?;
            if actual.pull_request != expected.pull_request {
                return Err(format!(
                    "prebuilt PR artifact is for pull request #{}, not #{}",
                    actual.pull_request, expected.pull_request
                ));
            }
            if !actual.repository.eq_ignore_ascii_case(&expected.repository) {
                return Err(format!(
                    "prebuilt PR artifact is for source repository {}, not {}",
                    actual.repository, expected.repository
                ));
            }
            if !actual.commit.eq_ignore_ascii_case(&expected.commit) {
                return Err(format!(
                    "prebuilt PR artifact is for source commit {}, not {}",
                    actual.commit, expected.commit
                ));
            }
        }
        Ok::<(PathBuf, RuntimeBundleManifest), String>((runtime_root, manifest))
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            remove_import_staging(&staging).await;
            return Err(format!("runtime bundle verification task failed: {error}"));
        }
    };
    let (runtime_root, manifest) = match verified {
        Ok(value) => value,
        Err(error) => {
            remove_import_staging(&staging).await;
            return Err(error);
        }
    };
    progress("verified", metadata.len() as f64, metadata.len() as f64);
    let size_root = runtime_root.clone();
    let size_mb = match tokio::task::spawn_blocking(move || dir_size(&size_root)).await {
        Ok(size_mb) => size_mb,
        Err(error) => {
            remove_import_staging(&staging).await;
            return Err(format!("runtime bundle size task failed: {error}"));
        }
    };
    let version = match preflight_staged_runtime(&runtime_root, progress, &cancel).await {
        Ok(version) => version,
        Err(error) => {
            remove_import_staging(&staging).await;
            return Err(error);
        }
    };
    if cancel.load(Ordering::Acquire) {
        remove_import_staging(&staging).await;
        return Err("runtime install cancelled".into());
    }
    if let Some(version) = version.as_ref() {
        write_version_manifest(&runtime_root, version);
    }
    let destination = runtime_dir(&manifest.backend, &manifest.build)?;
    let existing = read_source_manifest(&destination);
    let replace_root = runtime_root.clone();
    if let Err(error) =
        tokio::task::spawn_blocking(move || replace_runtime(&replace_root, &destination))
            .await
            .map_err(|error| format!("runtime bundle activation task failed: {error}"))?
    {
        remove_import_staging(&staging).await;
        return Err(error);
    }
    let cleanup_staging = staging.clone();
    let _ = tokio::task::spawn_blocking(move || remove_tree_bounded(&cleanup_staging)).await;
    progress("installed", 1.0, 1.0);
    let replaced = match (&existing, &manifest.source) {
        (Some(previous), Some(incoming)) => runtime_replacement(Some(previous), incoming),
        _ => None,
    };
    let destination = runtime_dir(&manifest.backend, &manifest.build)?;
    Ok(InstalledRuntime {
        build: manifest.build,
        backend: manifest.backend,
        dir: destination.to_string_lossy().into_owned(),
        size_mb,
        version: version.or(manifest.version),
        source: manifest.source,
        replaced,
    })
}

pub fn uninstall(backend: &str, build: &str) -> Result<(), String> {
    let dir = runtime_dir(backend, build)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| format!("failed to remove runtime: {error}"))?;
    }
    Ok(())
}

pub fn clear_api_cache() {
    if let Some(cache) = LATEST_CACHE.get() {
        if let Ok(mut value) = cache.lock() {
            *value = None;
        }
    }
    if let Some(cache) = LATEST_ERROR_CACHE.get() {
        if let Ok(mut value) = cache.lock() {
            *value = None;
        }
    }
    if let Some(cache) = ASSET_CACHE.get() {
        if let Ok(mut value) = cache.lock() {
            value.clear();
        }
    }
    if let Some(cache) = ASSET_ERROR_CACHE.get() {
        if let Ok(mut value) = cache.lock() {
            value.clear();
        }
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("llama-board/0.2")
        .timeout(Duration::from_secs(30))
        .build()
        .expect("static HTTP client configuration must be valid")
}

/// Runtime archives run from 17 MB to 373 MB, so the 30s whole-request budget
/// used for the GitHub API would abort every large transfer mid-stream. A
/// stalled connection is caught by the per-read timeout instead.
fn download_http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("llama-board/0.2")
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .expect("static HTTP client configuration must be valid")
}

async fn bounded_github_bytes(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_GITHUB_RESPONSE_BYTES as u64)
    {
        return Err("GitHub API response exceeds the 2 MiB limit".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("GitHub API response failed: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_GITHUB_RESPONSE_BYTES {
            return Err("GitHub API response exceeds the 2 MiB limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn bounded_github_text(response: reqwest::Response) -> Result<String, String> {
    let bytes = bounded_github_bytes(response).await?;
    String::from_utf8(bytes).map_err(|error| format!("GitHub API response was not UTF-8: {error}"))
}

fn parse_pull_request_ref(input: &str) -> Result<PullRequestRef, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > MAX_PR_INPUT_BYTES {
        return Err("enter a llama.cpp pull request number or GitHub URL".into());
    }

    let number_text = input.strip_prefix('#').unwrap_or(input);
    let number = if !number_text.is_empty()
        && number_text
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        number_text
            .parse::<u64>()
            .map_err(|_| "pull request number is too large".to_string())?
    } else {
        let parsed = reqwest::Url::parse(input)
            .map_err(|_| "enter a PR number or a GitHub llama.cpp PR URL".to_string())?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
            return Err(
                "PR URL must use https://github.com/ggml-org/llama.cpp/pull/<number>".into(),
            );
        }
        let segments: Vec<&str> = parsed
            .path_segments()
            .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
            .unwrap_or_default();
        if segments.len() < 4
            || segments[0] != "ggml-org"
            || segments[1] != "llama.cpp"
            || segments[2] != "pull"
        {
            return Err("PR URL must point to ggml-org/llama.cpp".into());
        }
        segments[3].parse::<u64>().map_err(|_| {
            "the GitHub URL does not contain a valid pull request number".to_string()
        })?
    };

    if number == 0 || format!("pr{number}").len() > 20 {
        return Err("pull request number is outside the supported range".into());
    }
    Ok(PullRequestRef { number })
}

pub fn pull_request_build_id(input: &str) -> Result<String, String> {
    let request = parse_pull_request_ref(input)?;
    Ok(format!("pr{}", request.number))
}

fn validate_source_repository(repository: &str) -> Result<(&str, &str), String> {
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || owner == "."
        || owner == ".."
        || name == "."
        || name == ".."
        || parts.next().is_some()
        || !owner
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err(format!(
            "pull request head repository is invalid: {repository}"
        ));
    }
    Ok((owner, name))
}

fn validate_commit_sha(commit: &str) -> Result<(), String> {
    if commit.len() != 40
        || !commit
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("GitHub returned an invalid pull request commit".into());
    }
    Ok(())
}

async fn resolve_pull_request(input: &str) -> Result<ResolvedPullRequest, String> {
    let request = parse_pull_request_ref(input)?;
    let response = http()
        .get(format!(
            "https://api.github.com/repos/{LLAMA_REPOSITORY}/pulls/{}",
            request.number
        ))
        .send()
        .await
        .map_err(|error| format!("GitHub pull request lookup failed: {error}"))?;
    let status = response.status();
    let raw = bounded_github_text(response).await?;
    if !status.is_success() {
        return Err(pull_request_lookup_error(request.number, status, &raw));
    }
    let detail: PullRequestDetail = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid GitHub pull request response: {error}"))?;
    parse_pull_request_source(request.number, detail)
}

/// Say what actually went wrong looking a pull request up.
///
/// `GitHub API 404: Not Found` tells a user nothing they can act on. Each of
/// these is a different situation with a different fix, and they are the three
/// that a person typing a PR number actually hits.
fn pull_request_lookup_error(number: u64, status: reqwest::StatusCode, body: &str) -> String {
    let detail = api_error(status, body);
    match status.as_u16() {
        404 => format!(
            "pull request #{number} was not found in {LLAMA_REPOSITORY}. Check the number, and note that llama-board only builds pull requests from that repository - an issue number, or a PR in a fork's own repository, will not resolve. ({detail})"
        ),
        403 | 429 => {
            if body.to_ascii_lowercase().contains("rate limit") {
                format!(
                    "GitHub is rate-limiting this machine, so pull request #{number} could not be looked up. Unauthenticated requests are limited per IP; wait for the limit to reset and try again. ({detail})"
                )
            } else {
                format!(
                    "GitHub refused the lookup for pull request #{number}. This is usually a network appliance or proxy blocking api.github.com. ({detail})"
                )
            }
        }
        451 => format!(
            "pull request #{number} is not available for legal reasons. ({detail})"
        ),
        500..=599 => format!(
            "GitHub had a server error looking up pull request #{number}; this is not something llama-board can fix, so try again shortly. ({detail})"
        ),
        _ => detail,
    }
}

/// A resolved pull request: the provenance that is recorded into the runtime,
/// plus the display-only fields that only the confirmation dialog needs.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedPullRequest {
    source: RuntimeSource,
    title: String,
    draft: bool,
    updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PullRequestArtifact {
    name: String,
    url: String,
    sha256: String,
    bytes: u64,
}

fn pull_request_artifact_name(pull_request: u64, backend: &str) -> String {
    format!(
        "llama-board-pr{pull_request}-{backend}-{}-{}.zip",
        release_platform(),
        bundle_architecture()
    )
}

fn pull_request_artifact_tag(pull_request: u64) -> String {
    format!("pr-runtime-{pull_request}")
}

/// Look up the exact prebuilt artifact for this app's platform and
/// architecture. A missing or temporarily unavailable artifact is not a
/// security failure: the caller can still offer the local source-build path.
async fn find_pull_request_artifact(
    source: &RuntimeSource,
    backend: &str,
) -> Result<Option<PullRequestArtifact>, String> {
    validate_source_build_backend(backend)?;
    let build = format!("pr{}", source.pull_request);
    validate_runtime_identifiers(backend, &build)?;
    validate_commit_sha(&source.commit)?;
    let tag = pull_request_artifact_tag(source.pull_request);
    let response = http()
        .get(format!(
            "https://api.github.com/repos/{PR_ARTIFACT_REPOSITORY}/releases/tags/{tag}"
        ))
        .send()
        .await
        .map_err(|error| format!("prebuilt PR artifact lookup failed: {error}"))?;
    let status = response.status();
    let raw = bounded_github_text(response).await?;
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!(
            "prebuilt PR artifact lookup returned HTTP {}: {}",
            status,
            api_error(status, &raw)
        ));
    }
    let release: ReleaseDetail = serde_json::from_str(&raw)
        .map_err(|error| format!("invalid prebuilt PR artifact response: {error}"))?;
    if release.tag_name != tag {
        return Err("prebuilt PR artifact release tag did not match the request".into());
    }
    let expected_name = pull_request_artifact_name(source.pull_request, backend);
    let Some(asset) = release
        .assets
        .into_iter()
        .find(|asset| asset.name == expected_name)
    else {
        return Ok(None);
    };
    validate_asset_file_name(&asset.name)?;
    validate_download_url(&asset.browser_download_url)?;
    let digest = normalize_digest(asset.digest.as_deref().ok_or_else(|| {
        "prebuilt PR artifact has no SHA-256 digest; refusing an unverified artifact".to_string()
    })?)?;
    if asset.size > MAX_ARCHIVE_BYTES {
        return Err("prebuilt PR artifact exceeds the configured archive size limit".into());
    }
    Ok(Some(PullRequestArtifact {
        name: asset.name,
        url: asset.browser_download_url,
        sha256: digest,
        bytes: asset.size,
    }))
}

/// Turn a GitHub pull request response into provenance, refusing anything that
/// does not identify a single concrete tree.
fn parse_pull_request_source(
    requested: u64,
    detail: PullRequestDetail,
) -> Result<ResolvedPullRequest, String> {
    if detail.number != requested {
        return Err("GitHub returned a different pull request number".into());
    }
    let repository = detail
        .head
        .repo
        .ok_or_else(|| {
            "the pull request head repository is no longer available, so its source cannot be downloaded".to_string()
        })?
        .full_name;
    validate_source_repository(&repository)?;
    let commit = detail.head.sha.trim().to_ascii_lowercase();
    validate_commit_sha(&commit)?;
    // A merged PR reports state "closed"; the distinction matters to someone
    // deciding whether to run this code, so surface it separately.
    let state = if detail.merged_at.is_some() {
        "merged".to_string()
    } else if detail.state.is_empty() {
        "unknown".to_string()
    } else {
        detail.state.clone()
    };
    Ok(ResolvedPullRequest {
        source: RuntimeSource {
            pull_request: requested,
            fork: !repository.eq_ignore_ascii_case(LLAMA_REPOSITORY),
            repository,
            head_ref: detail.head.reference.clone(),
            author: detail
                .user
                .as_ref()
                .map(|user| user.login.clone())
                .unwrap_or_default(),
            state,
            commit,
            archive_sha256: String::new(),
            commit_check: String::new(),
            url: format!("https://github.com/{LLAMA_REPOSITORY}/pull/{requested}"),
        },
        title: detail.title,
        draft: detail.draft,
        updated_at: detail.updated_at,
    })
}

/// Resolve a pull request for display only. Nothing is downloaded or built:
/// this is what the confirmation dialog shows before the user agrees to
/// compile someone else's branch on their own machine.
pub async fn pull_request_preview(
    backend: &str,
    source: &str,
) -> Result<PullRequestPreview, String> {
    validate_source_build_backend(backend)?;
    let resolved = resolve_pull_request(source).await?;
    let archive_url = source_archive_url(&resolved.source)?;
    let (artifact, artifact_error) =
        match find_pull_request_artifact(&resolved.source, backend).await {
            Ok(artifact) => (
                artifact.map(|artifact| PullRequestArtifactPreview {
                    name: artifact.name,
                    sha256: artifact.sha256,
                    bytes: artifact.bytes,
                }),
                None,
            ),
            Err(error) => (None, Some(error)),
        };
    Ok(preview_of(resolved, archive_url, artifact, artifact_error))
}

fn preview_of(
    resolved: ResolvedPullRequest,
    archive_url: String,
    artifact: Option<PullRequestArtifactPreview>,
    artifact_error: Option<String>,
) -> PullRequestPreview {
    let advisories = pull_request_advisories(&resolved);
    let ResolvedPullRequest {
        source,
        title,
        draft,
        updated_at,
    } = resolved;
    PullRequestPreview {
        pull_request: source.pull_request,
        title,
        state: source.state,
        draft,
        author: source.author,
        repository: source.repository,
        head_ref: source.head_ref,
        commit: source.commit,
        fork: source.fork,
        url: source.url,
        archive_url,
        updated_at,
        advisories,
        artifact,
        artifact_error,
    }
}

fn source_archive_url(source: &RuntimeSource) -> Result<String, String> {
    let (owner, repository) = validate_source_repository(&source.repository)?;
    validate_commit_sha(&source.commit)?;
    Ok(format!(
        "https://codeload.github.com/{owner}/{repository}/zip/{}",
        source.commit
    ))
}

/// Newest real build tag (skips release tags that are not b##### builds).
pub async fn latest_build() -> Result<String, String> {
    if let Some(build) = cached_latest() {
        return Ok(build);
    }
    if let Some(error) = cached_latest_error() {
        return Err(error);
    }
    let request_lock = LATEST_REQUEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _request = request_lock.lock().await;
    if let Some(build) = cached_latest() {
        return Ok(build);
    }
    if let Some(error) = cached_latest_error() {
        return Err(error);
    }
    let response = http()
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20")
        .send()
        .await
        .map_err(|error| {
            let message = format!("GitHub release lookup failed: {error}");
            cache_latest_error(&message);
            message
        })?;
    let status = response.status();
    let raw = bounded_github_text(response).await.inspect_err(|error| {
        cache_latest_error(error);
    })?;
    if !status.is_success() {
        let error = api_error(status, &raw);
        cache_latest_error(&error);
        return Err(error);
    }
    let releases: Vec<Rel> = serde_json::from_str(&raw).map_err(|error| {
        let message = format!("invalid GitHub release response: {error}");
        cache_latest_error(&message);
        message
    })?;
    let build = releases
        .into_iter()
        .find(|release| {
            release.tag_name.starts_with('b')
                && release.tag_name.len() <= 16
                && release.tag_name[1..]
                    .chars()
                    .all(|value| value.is_ascii_digit())
        })
        .map(|release| release.tag_name)
        .ok_or_else(|| "no b##### llama.cpp release found".to_owned())?;
    cache_latest(&build);
    Ok(build)
}

#[derive(Deserialize, Clone, Debug)]
struct ReleaseDetail {
    #[serde(default)]
    tag_name: String,
    assets: Vec<Asset>,
}

static LATEST_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
static LATEST_ERROR_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();
static ASSET_CACHE: OnceLock<Mutex<AssetCache>> = OnceLock::new();
static ASSET_ERROR_CACHE: OnceLock<Mutex<ErrorCache>> = OnceLock::new();
static LATEST_REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static ASSET_REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|message| message.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.lines().next().unwrap_or("request failed").to_owned());
    format!("GitHub API {status}: {message}")
}

fn cached_latest() -> Option<String> {
    LATEST_CACHE
        .get()?
        .lock()
        .ok()?
        .as_ref()
        .and_then(|(at, build)| (at.elapsed() < API_CACHE_TTL).then(|| build.clone()))
}

fn cached_latest_error() -> Option<String> {
    LATEST_ERROR_CACHE
        .get()?
        .lock()
        .ok()?
        .as_ref()
        .and_then(|(at, error)| (at.elapsed() < API_CACHE_TTL).then(|| error.clone()))
}

fn cache_latest_error(error: &str) {
    let cache = LATEST_ERROR_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut value) = cache.lock() {
        *value = Some((Instant::now(), error.to_owned()));
    }
}

fn cache_latest(build: &str) {
    let cache = LATEST_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut value) = cache.lock() {
        *value = Some((Instant::now(), build.to_owned()));
    }
}

fn cached_assets(build: &str) -> Option<Vec<Asset>> {
    let cache = ASSET_CACHE.get()?.lock().ok()?;
    cache
        .get(build)
        .and_then(|(at, assets)| (at.elapsed() < API_CACHE_TTL).then(|| assets.clone()))
}

fn cached_asset_error(build: &str) -> Option<String> {
    let cache = ASSET_ERROR_CACHE.get()?.lock().ok()?;
    cache
        .get(build)
        .and_then(|(at, error)| (at.elapsed() < API_CACHE_TTL).then(|| error.clone()))
}

fn cache_asset_error(build: &str, error: &str) {
    let cache = ASSET_ERROR_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut value) = cache.lock() {
        value.insert(build.to_owned(), (Instant::now(), error.to_owned()));
    }
}

fn cache_assets(build: &str, assets: &[Asset]) {
    let cache = ASSET_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut value) = cache.lock() {
        value.insert(build.to_owned(), (Instant::now(), assets.to_owned()));
    }
}

fn parse_release_assets(body: &str) -> Result<Vec<Asset>, String> {
    serde_json::from_str::<ReleaseDetail>(body)
        .map(|release| release.assets)
        .map_err(|error| error.to_string())
}

fn release_platform() -> &'static str {
    if cfg!(windows) {
        "win"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Pick a verified x64 asset for a backend.
async fn assets_for_build(build: &str) -> Result<Vec<Asset>, String> {
    if let Some(error) = cached_asset_error(build) {
        return Err(error);
    }
    if let Some(assets) = cached_assets(build) {
        return Ok(assets);
    }
    let request_lock = ASSET_REQUEST_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _request = request_lock.lock().await;
    if let Some(assets) = cached_assets(build) {
        return Ok(assets);
    }
    if let Some(error) = cached_asset_error(build) {
        return Err(error);
    }
    let response = http()
        .get(format!(
            "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{build}"
        ))
        .send()
        .await
        .map_err(|error| {
            let message = format!("GitHub asset lookup failed: {error}");
            cache_asset_error(build, &message);
            message
        })?;
    let status = response.status();
    let raw = bounded_github_text(response).await.inspect_err(|error| {
        cache_asset_error(build, error);
    })?;
    if !status.is_success() {
        let error = api_error(status, &raw);
        cache_asset_error(build, &error);
        return Err(error);
    }
    let assets = match parse_release_assets(&raw) {
        Ok(assets) => assets,
        Err(error) => {
            cache_asset_error(build, &error);
            return Err(error);
        }
    };
    cache_assets(build, &assets);
    Ok(assets)
}

/// llama.cpp ships the CUDA runtime DLLs (cudart/cublas) in a separate
/// `cudart-llama-bin-...` asset. Without them the staged `llama-server.exe`
/// cannot start on a machine that has no CUDA Toolkit on PATH, so the install
/// has to fetch that sidecar alongside the backend archive.
pub fn companion_asset_name(build: &str, main_file_name: &str) -> Option<String> {
    let suffix = main_file_name.strip_prefix(&format!("llama-{build}-bin-"))?;
    if !suffix.contains("-cuda-") {
        return None;
    }
    Some(format!("cudart-llama-bin-{suffix}"))
}

async fn companion_assets(build: &str, main_file_name: &str) -> Result<Vec<Asset>, String> {
    let Some(name) = companion_asset_name(build, main_file_name) else {
        return Ok(Vec::new());
    };
    let asset = assets_for_build(build)
        .await?
        .into_iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("release {build} is missing the CUDA runtime asset {name}"))?;
    Ok(vec![asset])
}

pub async fn latest_for(backend: &str) -> Result<LatestInfo, String> {
    if !CATALOG_BACKENDS.contains(&backend) {
        return Err(format!(
            "no downloadable catalog asset is defined for backend: {backend}"
        ));
    }
    let build = latest_build().await?;
    let assets = assets_for_build(&build).await?;

    let prefix = format!("llama-{build}-bin-{}-{backend}", release_platform());
    let asset = assets
        .iter()
        .find(|asset| {
            asset.name == format!("{prefix}-x64.zip")
                || (asset.name.starts_with(&prefix) && asset.name.ends_with("-x64.zip"))
        })
        .cloned()
        .ok_or_else(|| format!("no {backend} x64 asset for {build}"))?;
    Ok(LatestInfo {
        build,
        file_name: asset.name,
        url: asset.browser_download_url,
        digest: asset.digest,
    })
}

/// Where install progress goes. Keeping this behind a callback lets the whole
/// install path run under `cargo test` without a Tauri window.
pub type ProgressSink<'a> = &'a (dyn Fn(&str, f64, f64) + Send + Sync);

fn emit(app: &AppHandle, backend: &str, build: &str, phase: &str, received: f64, total: f64) {
    let _ = app.emit(
        "runtime-download-progress",
        serde_json::json!({
            "backend": backend,
            "build": build,
            "phase": phase,
            "received": received,
            "total": total
        }),
    );
}

fn validate_download_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|error| format!("invalid download URL: {error}"))?;
    if parsed.scheme() != "https" {
        return Err("runtime download URL must use HTTPS".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "github.com"
        && host != "codeload.github.com"
        && host != "objects.githubusercontent.com"
        && !host.ends_with(".githubusercontent.com")
    {
        return Err(format!("runtime download host is not trusted: {host}"));
    }
    Ok(())
}

fn normalize_digest(value: &str) -> Result<String, String> {
    let hex = value.strip_prefix("sha256:").unwrap_or(value).trim();
    if hex.len() != 64 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("release asset digest is not a SHA-256 value".into());
    }
    Ok(hex.to_ascii_lowercase())
}

fn validate_asset_file_name(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    if name.is_empty()
        || name.len() > 255
        || path.file_name().and_then(|value| value.to_str()) != Some(name)
        || !name.ends_with(".zip")
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return Err("release asset filename is not a safe ZIP basename".into());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    std::io::copy(&mut reader, &mut hasher).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub async fn install(
    app: AppHandle,
    backend: &str,
    build: &str,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, String> {
    install_with(
        &|phase, received, total| emit(&app, backend, build, phase, received, total),
        backend,
        build,
        cancel,
    )
    .await
}

pub async fn install_with(
    progress: ProgressSink<'_>,
    backend: &str,
    build: &str,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, String> {
    if cancel.load(Ordering::Acquire) {
        return Err("runtime install cancelled".into());
    }
    validate_runtime_identifiers(backend, build)?;
    let info = latest_for(backend).await?;
    if info.build != build {
        return Err(format!("requested {build} but latest is {}", info.build));
    }
    validate_asset_file_name(&info.file_name)?;
    let expected = normalize_digest(info.digest.as_deref().ok_or_else(|| {
        "release asset has no SHA-256 digest; refusing unverified install".to_string()
    })?)?;
    validate_download_url(&info.url)?;
    let companions = companion_assets(build, &info.file_name).await?;

    let root = runtimes_root();
    let download_root = app_data_root().join("llama-board").join("downloads");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    fs::create_dir_all(&download_root).map_err(|error| error.to_string())?;
    let nonce = short_nonce();
    let archive_path = download_root.join(format!(".{nonce}-{}.zip", info.file_name));
    let staging = root.join(format!(".{build}-{backend}.staging-{nonce}"));
    let mut cleanup = InstallCleanup::new(archive_path.clone(), staging.clone());

    let result = async {
        progress("downloading", 0.0, 0.0);
        download_to_file(progress, "downloading", &info.url, &archive_path, &cancel).await?;
        let hash_path = archive_path.clone();
        let actual = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
            .await
            .map_err(|error| format!("runtime hash task failed: {error}"))??;
        if actual != expected {
            return Err(format!(
                "runtime archive digest mismatch: expected {expected}, got {actual}"
            ));
        }
        progress("verified", 1.0, 1.0);

        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
        }
        progress("extracting", 0.0, 0.0);
        let extract_archive = archive_path.clone();
        let extract_staging = staging.clone();
        let extract_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            extract(&extract_archive, &extract_staging, &extract_cancel)?;
            verify_runtime_files(&extract_staging)
        })
        .await
        .map_err(|error| format!("runtime extraction task failed: {error}"))??;

        // Vendor sidecars (currently only the CUDA runtime) land in the same
        // staging directory so the preflight below sees a complete runtime.
        for companion in companions {
            if cancel.load(Ordering::Acquire) {
                return Err("runtime install cancelled".to_string());
            }
            validate_asset_file_name(&companion.name)?;
            let expected = normalize_digest(companion.digest.as_deref().ok_or_else(|| {
                format!(
                    "{} has no SHA-256 digest; refusing unverified install",
                    companion.name
                )
            })?)?;
            validate_download_url(&companion.browser_download_url)?;
            let companion_path = download_root.join(format!(".{nonce}-{}", companion.name));
            cleanup.track_archive(companion_path.clone());
            progress("downloading", 0.0, 0.0);
            download_to_file(
                progress,
                "downloading",
                &companion.browser_download_url,
                &companion_path,
                &cancel,
            )
            .await?;
            let hash_path = companion_path.clone();
            let actual = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
                .await
                .map_err(|error| format!("runtime hash task failed: {error}"))??;
            if actual != expected {
                return Err(format!(
                    "{} digest mismatch: expected {expected}, got {actual}",
                    companion.name
                ));
            }
            let extract_companion = companion_path.clone();
            let extract_staging = staging.clone();
            let extract_cancel = cancel.clone();
            tokio::task::spawn_blocking(move || {
                extract(&extract_companion, &extract_staging, &extract_cancel)
            })
            .await
            .map_err(|error| format!("runtime extraction task failed: {error}"))??;
        }

        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".to_string());
        }
        let size_staging = staging.clone();
        let size_mb = tokio::task::spawn_blocking(move || dir_size(&size_staging))
            .await
            .map_err(|error| format!("runtime size task failed: {error}"))?;
        let version = preflight_staged_runtime(&staging, progress, &cancel).await?;
        if let Some(version) = version.as_ref() {
            write_version_manifest(&staging, version);
        }
        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".to_string());
        }
        let destination = runtime_dir(backend, build)?;
        let replace_staging = staging.clone();
        tokio::task::spawn_blocking(move || replace_runtime(&replace_staging, &destination))
            .await
            .map_err(|error| format!("runtime activation task failed: {error}"))??;
        progress("installed", 1.0, 1.0);
        let dest = runtime_dir(backend, build)?;
        let installed = InstalledRuntime {
            build: build.into(),
            backend: backend.into(),
            dir: dest.to_string_lossy().into_owned(),
            size_mb,
            version,
            source: None,
            replaced: None,
        };
        cleanup.commit();
        Ok(installed)
    }
    .await;
    cleanup.finish().await;
    result
}

/// Build a pull request locally with the user's installed CMake/toolchain and
/// place the resulting server and bench binaries in the same managed-runtime
/// layout as release archives.
pub async fn install_pr(
    app: AppHandle,
    backend: &str,
    source: &str,
    confirmed_commit: &str,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, String> {
    let build = pull_request_build_id(source)?;
    install_pr_with(
        &|phase, received, total| emit(&app, backend, &build, phase, received, total),
        backend,
        source,
        confirmed_commit,
        cancel,
    )
    .await
}

async fn install_pr_artifact_with(
    progress: ProgressSink<'_>,
    backend: &str,
    source: &RuntimeSource,
    artifact: PullRequestArtifact,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, String> {
    let root = runtimes_root();
    let download_root = app_data_root().join("llama-board").join("downloads");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    fs::create_dir_all(&download_root).map_err(|error| error.to_string())?;
    if let Some(error) = free_space_error(
        "prebuilt PR runtime",
        &download_root,
        artifact.bytes.saturating_add(INSTALLED_RUNTIME_BYTES),
        available_bytes(&download_root),
    ) {
        return Err(error);
    }
    let archive_path = download_root.join(format!(".{}-{}", short_nonce(), artifact.name));
    let cleanup_path = archive_path.clone();
    let result = async {
        progress("resolving", 1.0, 1.0);
        progress("downloading", 0.0, artifact.bytes as f64);
        download_to_file(
            progress,
            "downloading",
            &artifact.url,
            &archive_path,
            &cancel,
        )
        .await?;
        import_bundle_with_digest(
            &archive_path,
            Some(&artifact.sha256),
            Some(backend),
            Some(source),
            progress,
            cancel,
        )
        .await
    }
    .await;
    let _ = tokio::task::spawn_blocking(move || fs::remove_file(cleanup_path)).await;
    result
}

/// Refuse a build whose head no longer matches what the user was shown.
///
/// The preview the user confirmed named one commit. Between that dialog and
/// this call the branch can be force-pushed, or a new commit pushed onto it -
/// which is exactly how an approved-looking PR turns into unreviewed code. The
/// confirmation is therefore for a *commit*, not for a PR number, and this is
/// where that is enforced. The frontend cannot skip it: the check runs here,
/// on data re-fetched from GitHub, not on anything the caller supplied.
fn confirm_pull_request_head(confirmed: &str, resolved: &RuntimeSource) -> Result<(), String> {
    let confirmed = confirmed.trim().to_ascii_lowercase();
    validate_commit_sha(&confirmed).map_err(|_| {
        "this build was not confirmed against a head commit; review the pull request details and confirm again".to_string()
    })?;
    if confirmed != resolved.commit {
        return Err(format!(
            "pull request #{} moved after you confirmed it: you approved commit {}, but its head is now {}. Review the new changes and confirm again before building them.",
            resolved.pull_request, confirmed, resolved.commit
        ));
    }
    Ok(())
}

pub async fn install_pr_with(
    progress: ProgressSink<'_>,
    backend: &str,
    source: &str,
    confirmed_commit: &str,
    cancel: Arc<AtomicBool>,
) -> Result<InstalledRuntime, String> {
    if cancel.load(Ordering::Acquire) {
        return Err("runtime install cancelled".into());
    }
    let mut origin = resolve_pull_request(source).await?.source;
    // Re-fetched from GitHub a moment ago, then matched against what the user
    // actually approved. Everything after this point is pinned to that commit.
    confirm_pull_request_head(confirmed_commit, &origin)?;
    let build = format!("pr{}", origin.pull_request);
    validate_runtime_identifiers(backend, &build)?;
    // Prefer a repository-produced artifact for this exact PR/backend when it
    // exists. This is the path used on normal end-user PCs: no CMake,
    // compiler, SDK, or source checkout is needed. The embedded manifest is
    // still checked against the freshly resolved commit before activation.
    let artifact_lookup_error = match find_pull_request_artifact(&origin, backend).await {
        Ok(Some(artifact)) => {
            return install_pr_artifact_with(progress, backend, &origin, artifact, cancel).await;
        }
        Ok(None) => None,
        Err(error) => Some(error),
    };
    // No artifact is available, so this is the developer/source-build path.
    // Refuse a missing local toolchain before downloading a multi-hundred-MB
    // source archive.
    let cmake = source_build_preflight(backend).await.map_err(|build_error| {
        if let Some(artifact_error) = artifact_lookup_error {
            format!(
                "prebuilt PR artifact lookup failed: {artifact_error}; local source build is unavailable: {build_error}"
            )
        } else {
            format!(
                "no compatible prebuilt PR artifact is published for this PC, and local source build is unavailable: {build_error}"
            )
        }
    })?;

    let root = runtimes_root();
    let download_root = app_data_root().join("llama-board").join("downloads");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    fs::create_dir_all(&download_root).map_err(|error| error.to_string())?;
    // Checked before the first byte is downloaded. Running out of disk halfway
    // through a build wastes both the download and the compile, and the error
    // the toolchain produces at that point rarely says "disk".
    if let Some(error) = free_space_error(
        "PR source build",
        &download_root,
        required_build_bytes(backend),
        available_bytes(&download_root),
    ) {
        return Err(error);
    }
    // The runtimes directory is frequently on a different drive from the
    // downloads directory, and the staged runtime plus the outgoing backup
    // both land there. Checking only the build volume would let an install
    // fail at the very last step, after the whole compile.
    if let Some(error) = free_space_error(
        "installed runtime",
        &root,
        INSTALLED_RUNTIME_BYTES,
        available_bytes(&root),
    ) {
        return Err(error);
    }
    // Short on purpose. Windows still enforces MAX_PATH for many toolchains,
    // and a llama.cpp build tree nests object files well over a hundred
    // characters deep beneath this directory; a full 32-character UUID here
    // spends that budget on nothing.
    let nonce = short_nonce();
    let workspace = download_root.join(format!(".{nonce}-{build}-{backend}"));
    fs::create_dir(&workspace).map_err(|error| error.to_string())?;
    let archive_path = workspace.join("source.zip");
    let source_extract = workspace.join("source");
    let build_root = workspace.join("build");
    let staging = root.join(format!(".{build}-{backend}.staging-{nonce}"));
    let mut cleanup = InstallCleanup::new(archive_path.clone(), staging.clone());
    cleanup.track_directory(workspace.clone());

    let result = async {
        let archive_url = source_archive_url(&origin)?;
        progress("resolving", 1.0, 1.0);
        progress("downloading source", 0.0, 0.0);
        download_to_file(
            progress,
            "downloading source",
            &archive_url,
            &archive_path,
            &cancel,
        )
        .await?;
        let hash_path = archive_path.clone();
        // GitHub publishes no digest for a source archive, so this hash is
        // computed here from the bytes we received. It records what was built;
        // it cannot confirm that those bytes were the right ones. The real
        // check is the commit id carried by the extracted tree, below.
        origin.archive_sha256 = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
            .await
            .map_err(|error| format!("runtime source hash task failed: {error}"))??;
        progress("recorded source digest", 1.0, 1.0);

        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".into());
        }
        progress("extracting source", 0.0, 0.0);
        let extract_archive = archive_path.clone();
        let extract_destination = source_extract.clone();
        let extract_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            extract(&extract_archive, &extract_destination, &extract_cancel)
        })
        .await
        .map_err(|error| format!("runtime source extraction task failed: {error}"))??;
        let extracted_root = source_extract.clone();
        let source_root = tokio::task::spawn_blocking(move || find_source_root(&extracted_root))
            .await
            .map_err(|error| format!("runtime source inspection task failed: {error}"))??;
        // The one genuine integrity check available here: GitHub names a
        // source archive's top-level directory after the ref it was asked for,
        // and we asked by commit id. A tree that carries a different commit is
        // not the one the user approved, so it is refused rather than built.
        origin.commit_check = match archive_commit_check(&source_root, &origin.commit) {
            ArchiveCommitCheck::Matches => COMMIT_CHECK_MATCHED.to_string(),
            ArchiveCommitCheck::Unknown => {
                return Err(format!(
                    "{COMMIT_CHECK_UNKNOWN}: the downloaded source does not expose a recognised commit directory, so llama-board refused to build it. Retry the pull request or inspect the archive manually; no runtime was activated."
                ));
            }
            ArchiveCommitCheck::Mismatch(found) => {
                return Err(format!(
                    "the downloaded source is not the commit you confirmed: the archive contains {found}, not {}. The download was not used.",
                    origin.commit
                ));
            }
        };

        // Only asked for a CUDA build, and only after the source is on disk,
        // so a machine with no NVIDIA driver never pays for the probe.
        let architectures = if backend == "cuda" {
            cuda_architectures(
                std::env::var(CUDA_ARCHITECTURES_OVERRIDE).ok().as_deref(),
                &detected_cuda_capabilities().await,
            )
        } else {
            String::new()
        };
        let configure_args =
            source_build_configure_args(backend, &source_root, &build_root, &architectures)?;
        progress("configuring", 0.0, 0.0);
        run_cmake_command(
            &cmake,
            backend,
            progress,
            "configuring",
            &configure_args,
            &workspace,
            &cancel,
        )
        .await?;

        let build_args = source_build_args(&build_root);
        progress("building", 0.0, 0.0);
        run_cmake_command(
            &cmake,
            backend,
            progress,
            "building",
            &build_args,
            &workspace,
            &cancel,
        )
        .await?;

        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".into());
        }
        progress("packaging", 0.0, 0.0);
        let build_root_for_find = build_root.clone();
        let binary_root =
            tokio::task::spawn_blocking(move || find_built_runtime_dir(&build_root_for_find))
                .await
                .map_err(|error| format!("runtime output inspection task failed: {error}"))??;
        let copy_source = binary_root.clone();
        let copy_destination = staging.clone();
        let copy_cancel = cancel.clone();
        let copy_backend = backend.to_string();
        tokio::task::spawn_blocking(move || {
            copy_runtime_tree(&copy_source, &copy_destination, &copy_cancel)?;
            copy_backend_runtime_dependencies(&copy_backend, &copy_destination, &copy_cancel)?;
            copy_msvc_runtime_dependencies(&copy_destination, &copy_cancel)?;
            verify_runtime_files(&copy_destination)
        })
        .await
        .map_err(|error| format!("runtime packaging task failed: {error}"))??;

        let size_staging = staging.clone();
        let size_mb = tokio::task::spawn_blocking(move || dir_size(&size_staging))
            .await
            .map_err(|error| format!("runtime size task failed: {error}"))?;
        let version = preflight_staged_runtime(&staging, progress, &cancel).await?;
        if let Some(version) = version.as_ref() {
            write_version_manifest(&staging, version);
        }
        // Provenance is part of the safety contract for a PR runtime. If the
        // manifest cannot be written, leave the staged bytes unactivated
        // rather than silently installing an unattributed build.
        write_source_manifest(&staging, &origin)?;
        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".into());
        }
        let destination = runtime_dir(backend, &build)?;
        // Read before the swap: after it, the old manifest is gone. One
        // directory per pull request means a rebuild displaces the previous
        // commit, and the user should be told which one.
        let replaced = runtime_replacement(read_source_manifest(&destination).as_ref(), &origin);
        let replace_staging = staging.clone();
        tokio::task::spawn_blocking(move || replace_runtime(&replace_staging, &destination))
            .await
            .map_err(|error| format!("runtime activation task failed: {error}"))??;
        progress("installed", 1.0, 1.0);
        let dest = runtime_dir(backend, &build)?;
        let installed = InstalledRuntime {
            build: build.clone(),
            backend: backend.into(),
            dir: dest.to_string_lossy().into_owned(),
            size_mb,
            version,
            source: Some(origin.clone()),
            replaced,
        };
        cleanup.commit();
        Ok(installed)
    }
    .await;
    // A PR build leaves the largest mess in the app: the extracted source and
    // the CMake build tree together run to several GB. Awaiting the blocking
    // handoff keeps the removal off the runtime and off the next install.
    progress("cleaning up", 0.0, 0.0);
    cleanup.finish().await;
    result
}

/// Check all local prerequisites before the PR confirmation dialog is shown.
///
/// The installer calls this again after confirmation because a user can leave
/// the dialog open while changing their toolchain. Returning the located CMake
/// keeps the second call from resolving a different executable between the
/// preflight and configure steps.
pub async fn source_build_preflight(backend: &str) -> Result<PathBuf, String> {
    validate_source_build_backend(backend)?;
    // Tool discovery walks Visual Studio/SDK installation trees. Keep that
    // filesystem work off Tokio's async worker so a slow or disconnected
    // installation cannot freeze the UI while the confirmation screen is
    // being prepared.
    let backend_for_lookup = backend.to_string();
    let (toolchain_error, cmake) = tokio::task::spawn_blocking(move || {
        let toolchain_error = source_build_toolchain_error(&backend_for_lookup);
        let cmake = if toolchain_error.is_none() {
            locate_cmake()
        } else {
            None
        };
        (toolchain_error, cmake)
    })
    .await
    .map_err(|error| format!("source build toolchain lookup task failed: {error}"))?;
    if let Some(error) = toolchain_error {
        return Err(error);
    }
    let cmake = cmake.ok_or_else(cmake_not_found_error)?;
    // Run it once. A CMake that is too old, or broken, is far cheaper to find
    // out about here than after a source download and a ten-minute configure.
    cmake_preflight(&cmake).await?;
    Ok(cmake)
}

/// Backends a local pull-request source build can honestly produce.
///
/// CPU needs no vendor SDK, Vulkan needs the LunarG SDK's `glslc`, CUDA needs
/// the toolkit's `nvcc`, and ROCm needs `hipcc` plus a ROCm/HIP SDK. CUDA and
/// ROCm runtime libraries and their kernel data are copied beside the staged
/// binaries when the SDK exposes them. GPU driver libraries are deliberately
/// not copied: they belong to the host driver.
pub const SOURCE_BUILD_BACKENDS: &[&str] = &["cpu", "vulkan", "cuda", "rocm"];

/// Reject a backend that cannot be built from source on an ordinary machine,
/// before anything is resolved, downloaded or extracted.
pub fn validate_source_build_backend(backend: &str) -> Result<(), String> {
    validate_catalog_backend(backend)?;
    if SOURCE_BUILD_BACKENDS.contains(&backend) {
        return Ok(());
    }
    let reason = match backend {
        "sycl" => "the Intel oneAPI icx/icpx compiler driver and the environment that setvars installs, neither of which this build inherits",
        "openvino" => "the OpenVINO toolkit, its setupvars environment, and OpenVINO runtime libraries that are not part of the build tree",
        _ => "a vendor toolchain and runtime libraries that llama-board cannot detect or package",
    };
    Err(format!(
        "PR builds are not supported for the {backend} backend: it needs {reason}. Install a released {backend} runtime from the backend list instead, or build this PR yourself with the vendor toolchain. PR builds are supported for: {}.",
        SOURCE_BUILD_BACKENDS.join(", ")
    ))
}

/// Host toolchain lookups, injected so the preflight policy can be tested
/// without depending on what happens to be installed on the test machine.
struct ToolchainView<'a> {
    executable: &'a dyn Fn(&str) -> bool,
    directory_variable: &'a dyn Fn(&str) -> bool,
}

fn missing_host_compiler(view: &ToolchainView<'_>) -> Option<String> {
    if cfg!(windows) {
        if !(view.executable)("cl") {
            return Some(
                "a PR build needs the Microsoft C/C++ compiler (cl.exe). Install Visual Studio Build Tools with the Desktop development with C++ workload, or open llama-board from a Visual Studio Developer Command Prompt, then try again.".to_string(),
            );
        }
    } else if !(view.executable)("cc") && !(view.executable)("gcc") && !(view.executable)("clang") {
        return Some(
            "a PR build needs a C compiler (cc, gcc, or clang). Install your platform's C/C++ development toolchain and try again (for example `xcode-select --install` on macOS or `apt install build-essential` on Debian/Ubuntu).".to_string(),
        );
    } else if !(view.executable)("c++")
        && !(view.executable)("g++")
        && !(view.executable)("clang++")
    {
        return Some(
            "a PR build needs a C++ compiler (c++, g++, or clang++). Install your platform's C++ development toolchain and try again (for example `xcode-select --install` on macOS or `apt install build-essential` on Debian/Ubuntu).".to_string(),
        );
    }
    None
}

/// Explain what is missing for a supported source build, or `None` when the
/// machine already has what the backend needs.
fn missing_source_build_toolchain(backend: &str, view: &ToolchainView<'_>) -> Option<String> {
    if let Some(error) = missing_host_compiler(view) {
        return Some(error);
    }
    match backend {
        "cuda" => (!(view.executable)("nvcc"))
        .then(|| {
            "a CUDA PR build needs the NVIDIA CUDA Toolkit compiler: install it and make sure nvcc is on PATH (or set CUDACXX to its full path), then try again. Without a toolkit, install a released CUDA runtime or build the PR for the vulkan or cpu backend."
                .to_string()
        }),
        "rocm" => {
            let has_sdk = (view.directory_variable)("HIP_PATH")
                || (view.directory_variable)("ROCM_PATH");
            if !(view.executable)("hipcc") || !has_sdk {
                Some(
                    "a ROCm PR build needs the AMD ROCm/HIP SDK and its hipcc compiler: install ROCm, make sure hipcc is on PATH, and set HIP_PATH or ROCM_PATH to the SDK root, then try again. The finished build is tied to this machine's installed AMD driver."
                        .to_string(),
                )
            } else if !(view.executable)("clang") || !(view.executable)("clang++") {
                Some(
                    "this ROCm installation is missing its clang/clang++ compiler pair. Repair the ROCm/HIP SDK or add its bin/llvm/bin directories to PATH, then try again."
                        .to_string(),
                )
            } else {
                None
            }
        }
        "vulkan" => (!(view.executable)("glslc"))
        .then(|| {
            "a Vulkan PR build needs the LunarG Vulkan SDK's glslc shader compiler: install the SDK and make sure glslc is on PATH (or set VULKAN_SDK/VK_SDK_PATH to a complete SDK), then try again. Without the SDK, install a released Vulkan runtime or build the PR for the cpu backend."
                .to_string()
        }),
        _ => None,
    }
}

fn source_build_toolchain_error(backend: &str) -> Option<String> {
    let executable = |name: &str| locate_tool(name).is_some();
    let rocm_sdk_present = rocm_sdk_is_configured();
    let directory_variable = |name: &str| {
        if matches!(name, "HIP_PATH" | "ROCM_PATH") {
            rocm_sdk_present
        } else {
            std::env::var_os(name)
                .map(|value| Path::new(&value).is_dir())
                .unwrap_or(false)
        }
    };
    if let Some(error) = missing_source_build_toolchain(
        backend,
        &ToolchainView {
            executable: &executable,
            directory_variable: &directory_variable,
        },
    ) {
        return Some(error);
    }
    #[cfg(windows)]
    if locate_msvc_crt_directory().is_none() {
        return Some(
            "a Windows PR build needs the MSVC C/C++ runtime redistributable so the finished llama-server can run on a PC without Visual Studio. Install Visual Studio Build Tools with the Desktop development with C++ workload and its redistributable component, then try again.".into(),
        );
    }
    #[cfg(windows)]
    if backend == "rocm" && !windows_clang_link_environment_ready() {
        return Some(
            "the Windows ROCm build also needs the Windows SDK import and library paths. Install the Windows 10/11 SDK through Visual Studio Build Tools with the Desktop development with C++ workload, then try again. llama-board does not need a Developer Command Prompt; it loads the paths automatically when the SDK is installed.".into(),
        );
    }
    #[cfg(windows)]
    if backend == "rocm" && locate_ninja().is_none() {
        return Some(
            "a Windows ROCm PR build needs Ninja because llama.cpp's HIP sources must be compiled with the ROCm clang toolchain. Install Ninja (or the CMake tools component in Visual Studio Build Tools) and put ninja.exe on PATH, then try again.".into(),
        );
    }
    None
}

#[cfg(windows)]
fn windows_clang_link_environment_ready() -> bool {
    let Some(cl) = locate_tool("cl") else {
        return false;
    };
    let mut environment = build_environment();
    merge_visual_studio_environment(&mut environment, &cl);
    let has_directory = |name: &str| {
        environment_value(&environment, name)
            .map(|value| std::env::split_paths(&value).any(|path| path.is_dir()))
            .unwrap_or(false)
    };
    let has_windows_library = environment_value(&environment, "LIB")
        .map(|value| std::env::split_paths(&value).any(|path| path.join("kernel32.lib").is_file()))
        .unwrap_or(false);
    has_directory("INCLUDE") && has_windows_library
}

pub fn validate_catalog_backend(backend: &str) -> Result<(), String> {
    if CATALOG_BACKENDS.contains(&backend) {
        Ok(())
    } else {
        Err(format!("unknown llama.cpp backend: {backend}"))
    }
}

/// Options that keep a PR configure inside the archive already on disk.
///
/// The source archive is downloaded once, pinned to a commit, and its digest
/// recorded. Anything CMake fetches *afterwards* - a `FetchContent` clone, a
/// `find_package` that falls back to a download - is outside that boundary:
/// it is not pinned, not recorded, needs Git and network on every PC, and on a
/// machine behind a proxy or without Git it fails deep into a long build
/// instead of at the start.
///
/// So each of these is turned off rather than made to work:
///
/// - `LLAMA_BUILD_BORINGSSL`: BoringSSL is a `FetchContent` Git clone that
///   additionally needs a Go toolchain. It exists to give `llama-server` an
///   HTTPS listener. llama-board talks to the server over loopback HTTP and
///   never sets `--ssl-key-file`, so the dependency buys nothing here.
/// - `LLAMA_CURL` / `LLAMA_OPENSSL`: these power the server's own
///   download-a-model-by-URL path and need libcurl/OpenSSL development
///   packages that most Windows PCs do not have. llama-board manages models
///   itself and never asks the server to fetch one.
///
/// An unknown `-D` is a warning in CMake, not an error, so setting these on a
/// PR whose tree has never heard of them is safe.
///
/// `FETCHCONTENT_QUIET=OFF` does not disable anything - it makes any fetch
/// that still happens visible in the log, so `build_failure_hint` can name it.
const SOURCE_BUILD_OFFLINE_OPTIONS: &[&str] = &[
    "-DLLAMA_BUILD_BORINGSSL=OFF",
    "-DLLAMA_CURL=OFF",
    "-DLLAMA_OPENSSL=OFF",
    // llama-board talks to the server's loopback API and never opens the
    // server's embedded browser UI. A PR archive may still contain a full
    // tools/ui source tree, whose default CMake path runs npm (or fetches a
    // prebuilt asset from Hugging Face), so disable both paths explicitly.
    "-DLLAMA_BUILD_UI=OFF",
    "-DLLAMA_USE_PREBUILT_UI=OFF",
];

/// Turn the tail of a failed build into something the user can act on.
///
/// A CMake failure is thousands of lines that end in a one-line error, and the
/// error is rarely self-explanatory to someone who did not choose to run a
/// compiler. Each arm below is a failure that a normal PC actually hits.
fn build_failure_hint(log: &str) -> Option<&'static str> {
    let lowered = log.to_ascii_lowercase();
    let contains_any = |needles: &[&str]| needles.iter().any(|needle| lowered.contains(needle));

    if contains_any(&[
        "fetchcontent",
        "failed to clone",
        "git did not exit cleanly",
        "could not resolve host",
        "could not resolve proxy",
        "unable to access 'https",
        "ssl certificate problem",
        "server certificate verification failed",
    ]) {
        return Some(
            "this PR's build tried to download a dependency of its own. llama-board pins and verifies only the PR source archive, so a build that fetches more needs Git and working network access (including your proxy and CA bundle) on this PC. Install Git, check HTTPS_PROXY/SSL_CERT_FILE if you are behind a proxy, or install a released runtime instead.",
        );
    }
    if contains_any(&[
        "no cmake_cxx_compiler could be found",
        "no cmake_c_compiler could be found",
        "could not find any instance of visual studio",
        "no suitable generator",
        "cmake_make_program is not set",
    ]) {
        return Some(
            "no C++ compiler was found. Install the Visual Studio Build Tools with the \"Desktop development with C++\" workload on Windows, Xcode command line tools on macOS, or a gcc/clang toolchain and Ninja on Linux, then try again.",
        );
    }
    if contains_any(&[
        "no space left on device",
        "there is not enough space on the disk",
        "0x80070070",
    ]) {
        return Some(
            "the disk filled up. A llama.cpp build needs several GB of free space for the extracted source and the build tree; free some space and try again.",
        );
    }
    if contains_any(&["nvcc fatal", "unsupported gpu architecture"]) {
        return Some(
            "the CUDA compiler rejected the build. This usually means the installed CUDA Toolkit is too old for this PR; update the toolkit, or build this PR for the vulkan or cpu backend.",
        );
    }
    if contains_any(&["glslc", "spir-v", "shaderc"]) {
        return Some(
            "the Vulkan shader compiler failed. Make sure the LunarG Vulkan SDK is installed and glslc is on PATH, or build this PR for the cpu backend.",
        );
    }
    if contains_any(&["out of memory", "c1060", "compiler is out of heap space"]) {
        return Some(
            "the compiler ran out of memory. Close other applications and try again; a parallel llama.cpp build can need several GB of RAM per core.",
        );
    }
    None
}

/// Environment variable that hands the CUDA architecture list to the user.
///
/// Accepts exactly what `CMAKE_CUDA_ARCHITECTURES` accepts, e.g. `89-real`, or
/// `75-real;80-real;90-virtual`, or the word `all`.
const CUDA_ARCHITECTURES_OVERRIDE: &str = "LLAMA_BOARD_CUDA_ARCHITECTURES";

/// The list used when the host's GPU generation cannot be determined.
///
/// Deliberately not llama.cpp's own default (which spans a decade of hardware
/// and multiplies the compile time of every CUDA kernel by the length of the
/// list): these are the generations a machine running a current llama.cpp
/// actually has, and the trailing `-virtual` entry emits PTX so a newer card
/// than any of them still runs the result through driver JIT.
const CUDA_ARCHITECTURES_PORTABLE: &str = "75-real;80-real;86-real;89-real;90-virtual";

/// Reject anything that is not a CUDA architecture list, so an environment
/// variable cannot smuggle extra arguments into the configure line.
fn valid_cuda_architectures(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    if value.eq_ignore_ascii_case("all") || value.eq_ignore_ascii_case("all-major") {
        return true;
    }
    value.split(';').all(|entry| {
        let entry = entry.trim();
        let digits = entry
            .trim_end_matches("-real")
            .trim_end_matches("-virtual")
            .trim_end_matches('a')
            .trim_end_matches('f');
        !digits.is_empty()
            && digits.len() <= 4
            && digits.chars().all(|character| character.is_ascii_digit())
    })
}

/// Turn detected compute capabilities (`["8.9", "8.6"]`) into a CMake list.
///
/// Real code is emitted for each capability found, and PTX for the newest one,
/// so the build stays usable if the user later drops in a newer card. This is
/// the whole point of doing it host-aware: a machine with one RTX 4090 spends
/// its compile budget on `89` instead of on five generations it will never run.
fn cuda_architectures_for_host(capabilities: &[String]) -> Option<String> {
    let mut codes: Vec<u32> = capabilities
        .iter()
        .filter_map(|capability| {
            let mut parts = capability.trim().split('.');
            let major = parts.next()?.parse::<u32>().ok()?;
            let minor = parts.next().unwrap_or("0").parse::<u32>().ok()?;
            (major >= 5).then_some(major * 10 + minor)
        })
        .collect();
    codes.sort_unstable();
    codes.dedup();
    let newest = *codes.last()?;
    let mut entries: Vec<String> = codes.iter().map(|code| format!("{code}-real")).collect();
    entries.push(format!("{newest}-virtual"));
    Some(entries.join(";"))
}

/// The CUDA architecture list for this build: the user's choice if they made
/// one, else the host's own GPUs, else a portable list.
fn cuda_architectures(override_value: Option<&str>, detected: &[String]) -> String {
    if let Some(value) = override_value {
        let value = value.trim();
        if valid_cuda_architectures(value) {
            return value.to_string();
        }
    }
    cuda_architectures_for_host(detected).unwrap_or_else(|| CUDA_ARCHITECTURES_PORTABLE.to_string())
}

/// Ask the driver what is installed. Present on every machine with a working
/// NVIDIA driver, which a CUDA build already requires.
async fn detected_cuda_capabilities() -> Vec<String> {
    let Ok(smi) = which::which("nvidia-smi") else {
        return Vec::new();
    };
    let probe = run_probe(&smi, &["--query-gpu=compute_cap", "--format=csv,noheader"]).await;
    if !probe.success {
        return Vec::new();
    }
    probe
        .text
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && line.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .collect()
}

/// What a PR build produces, stated once so the UI, the docs and the build
/// itself cannot drift apart.
///
/// llama-board builds the server and the benchmark tool, and nothing else.
/// Tests and examples are off because they roughly double the build for code
/// llama-board never runs. The server's optional embedded web UI is **not**
/// built here: llama-board uses the loopback API directly, so no Node
/// toolchain is needed and no UI asset is fetched at build time - the same
/// reason the network options in `SOURCE_BUILD_OFFLINE_OPTIONS` are off.
pub const SOURCE_BUILD_TARGETS: &[&str] = &["llama-server", "llama-bench"];

fn source_build_configure_args(
    backend: &str,
    source_root: &Path,
    build_root: &Path,
    cuda_architectures: &str,
) -> Result<Vec<String>, String> {
    validate_source_build_backend(backend)?;
    let backend_option = match backend {
        "vulkan" => "GGML_VULKAN",
        "cuda" => "GGML_CUDA",
        "rocm" => "GGML_HIP",
        "cpu" => "GGML_CPU",
        _ => unreachable!("validate_source_build_backend checked the backend"),
    };
    let backend_extra = match backend {
        // Without an explicit list CMake compiles every architecture llama.cpp
        // names by default, which is the single biggest cost in a CUDA build.
        "cuda" => vec![format!("-DCMAKE_CUDA_ARCHITECTURES={cuda_architectures}")],
        _ => Vec::new(),
    };
    let mut args = vec![
        "-S".into(),
        source_root.to_string_lossy().into_owned(),
        "-B".into(),
        build_root.to_string_lossy().into_owned(),
        "-DCMAKE_BUILD_TYPE=Release".into(),
        "-DGGML_NATIVE=OFF".into(),
        "-DBUILD_SHARED_LIBS=ON".into(),
        "-DGGML_BACKEND_DL=ON".into(),
        "-DGGML_CPU_ALL_VARIANTS=ON".into(),
        "-DLLAMA_BUILD_COMMON=ON".into(),
        "-DLLAMA_BUILD_SERVER=ON".into(),
        "-DLLAMA_BUILD_TOOLS=ON".into(),
        "-DLLAMA_BUILD_TESTS=OFF".into(),
        "-DLLAMA_BUILD_EXAMPLES=OFF".into(),
        // Make any fetch that still happens visible in the log so
        // `build_failure_hint` can name it.
        "-DFETCHCONTENT_QUIET=OFF".into(),
        format!("-D{backend_option}=ON"),
    ]
    .into_iter()
    // Keep the configure inside the source archive that was already
    // downloaded and hash-recorded.
    .chain(
        SOURCE_BUILD_OFFLINE_OPTIONS
            .iter()
            .map(|option| (*option).to_string()),
    )
    .chain(backend_extra)
    .collect::<Vec<_>>();
    #[cfg(windows)]
    if backend == "rocm" {
        // ROCm's Windows CMake path treats HIP sources as C++ because CMake's
        // native HIP language support is unavailable there. The upstream
        // build recipe therefore uses Ninja plus ROCm's clang pair; the
        // Visual Studio generator otherwise hands .cu files to cl.exe.
        let mut toolchain = vec![
            "-G".to_string(),
            "Ninja".to_string(),
            "-DCMAKE_C_COMPILER=clang".to_string(),
            "-DCMAKE_CXX_COMPILER=clang++".to_string(),
        ];
        toolchain.append(&mut args);
        args = toolchain;
    }
    // Windows resolves DLLs beside the executable. On Unix, keep vendor
    // libraries beside the staged binaries and ask the platform loader to
    // search that directory after activation. The token is intentionally
    // passed as an argv value; it is not shell-expanded.
    if matches!(backend, "cuda" | "rocm") {
        if let Some(rpath) = portable_runtime_rpath() {
            args.push(format!("-DCMAKE_BUILD_RPATH={rpath}"));
            args.push(format!("-DCMAKE_INSTALL_RPATH={rpath}"));
            args.push("-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON".into());
        }
    }
    Ok(args)
}

#[cfg(target_os = "macos")]
fn portable_runtime_rpath() -> Option<&'static str> {
    Some("@loader_path")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn portable_runtime_rpath() -> Option<&'static str> {
    Some("$ORIGIN")
}

#[cfg(not(unix))]
fn portable_runtime_rpath() -> Option<&'static str> {
    None
}

fn valid_parallelism(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.chars().all(|character| character.is_ascii_digit())
        && value.parse::<u32>().map(|jobs| jobs > 0).unwrap_or(false)
}

fn source_build_args_with_parallelism(build_root: &Path, parallelism: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--build".into(),
        build_root.to_string_lossy().into_owned(),
        "--config".into(),
        "Release".into(),
        "--target".into(),
    ];
    args.extend(
        SOURCE_BUILD_TARGETS
            .iter()
            .map(|target| (*target).to_string()),
    );
    match parallelism {
        // CMake's default when no --parallel value is supplied is the full
        // core count. Keep that behaviour when the user has not configured a
        // cap, while ensuring a configured CMAKE_BUILD_PARALLEL_LEVEL is not
        // overridden by a bare --parallel flag.
        None => args.push("--parallel".into()),
        Some(value) if valid_parallelism(value) => {
            args.push("--parallel".into());
            args.push(value.trim().to_string());
        }
        Some(_) => {
            // Leave the flag out for an invalid value. CMake will report the
            // invalid environment value instead of silently falling back to
            // all cores, which could exhaust memory.
        }
    }
    args
}

fn source_build_args(build_root: &Path) -> Vec<String> {
    // `var_os` matters here: an environment variable that is present but not
    // valid Unicode is still present and must not accidentally trigger the
    // bare full-core `--parallel` fallback.
    let parallelism = std::env::var_os("CMAKE_BUILD_PARALLEL_LEVEL")
        .map(|value| value.to_string_lossy().into_owned());
    source_build_args_with_parallelism(build_root, parallelism.as_deref())
}

/// What a supervised build step produced: its exit status plus a bounded tail
/// of each pipe.
#[derive(Debug)]
struct BuildCommandOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Wait for a long-running build child, emitting a progress tick every second
/// and honouring both cancellation and `deadline`.
///
/// Both pipes are drained for the entire life of the child - a build that
/// writes more than the retained tail has to keep running, not deadlock on a
/// full pipe or die on a broken one - and they are only joined after the
/// process has exited, so no handle is ever closed under a live child.
async fn supervise_build_child(
    mut child: tokio::process::Child,
    progress: ProgressSink<'_>,
    phase: &str,
    label: &str,
    cancel: &Arc<AtomicBool>,
    deadline: Duration,
) -> Result<BuildCommandOutput, String> {
    let Some(stdout) = child.stdout.take() else {
        terminate_probe(&mut child).await;
        return Err(format!("{label} stdout was not captured"));
    };
    let readers = BuildReaders::attach(stdout, child.stderr.take());
    let started = Instant::now();
    let status = loop {
        if cancel.load(Ordering::Acquire) {
            terminate_build_child(&mut child).await;
            let _ = readers.finish(CANCEL_READER_TIMEOUT).await;
            return Err("runtime install cancelled".into());
        }
        let elapsed = started.elapsed();
        if elapsed >= deadline {
            // The deadline is a backstop against a hung compiler or a stalled
            // network probe, not a normal exit path: kill the tree the same
            // way cancellation does, then hand back whatever the log already
            // captured so the failure is actionable.
            terminate_build_child(&mut child).await;
            let (stdout, stderr) = readers.finish(CANCEL_READER_TIMEOUT).await;
            let detail = build_failure_detail(&stdout, &stderr);
            let mut message = format!(
                "{label} exceeded its {} timeout after {} and was terminated",
                format_seconds(deadline),
                format_seconds(elapsed)
            );
            if !detail.is_empty() {
                message.push_str(": ");
                message.push_str(&detail);
            }
            return Err(message);
        }
        let tick = Duration::from_secs(1).min(deadline - elapsed);
        tokio::select! {
            result = child.wait() => {
                match result {
                    Ok(status) => break status,
                    // The child is unreachable but not necessarily gone: kill
                    // the tree and join the drains before returning, so no
                    // pipe outlives this call and no build is left orphaned.
                    Err(error) => {
                        terminate_build_child(&mut child).await;
                        let _ = readers.finish(CANCEL_READER_TIMEOUT).await;
                        return Err(format!("{label} wait failed: {error}"));
                    }
                }
            }
            _ = sleep(tick) => {
                progress(phase, started.elapsed().as_secs_f64(), 0.0);
            }
        }
    };
    let (stdout, stderr) = readers.finish(BUILD_READER_TIMEOUT).await;
    Ok(BuildCommandOutput {
        status,
        stdout,
        stderr,
    })
}

/// The drain tasks of a supervised build child, kept together so every exit
/// path joins both of them before the call returns.
struct BuildReaders {
    stdout: (JoinHandle<()>, SharedLog),
    stderr: Option<(JoinHandle<()>, SharedLog)>,
}

impl BuildReaders {
    fn attach(
        stdout: tokio::process::ChildStdout,
        stderr: Option<tokio::process::ChildStderr>,
    ) -> Self {
        let stdout_log = shared_log();
        let stdout_task = tokio::spawn(drain_stream_into(
            stdout,
            stdout_log.clone(),
            MAX_BUILD_LOG_TAIL,
            Retain::Tail,
        ));
        let stderr = stderr.map(|stderr| {
            let log = shared_log();
            let task = tokio::spawn(drain_stream_into(
                stderr,
                log.clone(),
                MAX_BUILD_LOG_TAIL,
                Retain::Tail,
            ));
            (task, log)
        });
        Self {
            stdout: (stdout_task, stdout_log),
            stderr,
        }
    }

    async fn finish(self, limit: Duration) -> (Vec<u8>, Vec<u8>) {
        let (task, log) = self.stdout;
        let stdout = finish_build_reader(task, &log, limit).await;
        let stderr = match self.stderr {
            Some((task, log)) => finish_build_reader(task, &log, limit).await,
            None => Vec::new(),
        };
        (stdout, stderr)
    }
}

/// Render a duration as seconds with one decimal place. The same format
/// reads naturally for a minute-scale production timeout and a
/// millisecond-scale test deadline alike.
fn format_seconds(duration: Duration) -> String {
    format!("{:.1}s", duration.as_secs_f64())
}

/// Last `limit` characters of `text`, so a failure report keeps the diagnostic
/// that ended the build instead of the banner that started it.
fn tail_chars(text: &str, limit: usize) -> String {
    let mut tail = text.chars().rev().take(limit).collect::<Vec<_>>();
    tail.reverse();
    tail.into_iter().collect()
}

/// Human-readable tail of a failed build step: stdout first, then stderr.
fn build_failure_detail(stdout: &[u8], stderr: &[u8]) -> String {
    let mut output = String::from_utf8_lossy(stdout).into_owned();
    let stderr = String::from_utf8_lossy(stderr);
    if !stderr.trim().is_empty() {
        output.push('\n');
        output.push_str(stderr.trim());
    }
    tail_chars(output.trim(), MAX_BUILD_DETAIL_CHARS)
        .trim()
        .to_string()
}

/// The configure step only ever runs `cmake -S -B`; anything else invoked
/// through this helper is the build step, which needs the much larger budget.
fn cmake_phase_timeout(phase: &str) -> Duration {
    if phase == "configuring" {
        CMAKE_CONFIGURE_TIMEOUT
    } else {
        CMAKE_BUILD_TIMEOUT
    }
}

async fn run_cmake_command(
    cmake: &Path,
    backend: &str,
    progress: ProgressSink<'_>,
    phase: &str,
    args: &[String],
    current_dir: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let deadline = cmake_phase_timeout(phase);
    let mut command = Command::new(cmake);
    configure_build_process_group(&mut command);
    command
        .env_clear()
        .envs(build_environment_for_backend(cmake, backend))
        .current_dir(current_dir);
    let child = command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start CMake for {phase}: {error}"))?;
    let pid = child.id();
    if let Some(pid) = pid {
        register_active_build(pid);
    }
    let label = format!("CMake {phase}");
    let supervised = supervise_build_child(child, progress, phase, &label, cancel, deadline).await;
    if let Some(pid) = pid {
        unregister_active_build(pid);
    }
    let output = supervised?;
    if output.status.success() {
        return Ok(());
    }
    let detail = build_failure_detail(&output.stdout, &output.stderr);
    let mut message = format!(
        "{label} failed with {}: {}",
        output.status,
        if detail.is_empty() {
            "no diagnostic output"
        } else {
            detail.as_str()
        }
    );
    if let Some(hint) = build_failure_hint(&detail) {
        message.push_str("\n\nWhat to do: ");
        message.push_str(hint);
    }
    Err(message)
}

/// Recorded in the source manifest so a runtime says how well its origin is
/// established, rather than implying more than was actually checked.
const COMMIT_CHECK_MATCHED: &str = "archive-directory-matches-commit";
const COMMIT_CHECK_UNKNOWN: &str = "archive-layout-unrecognised";

/// What the extracted tree proves about which commit it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ArchiveCommitCheck {
    /// The top-level directory names exactly the commit that was requested.
    Matches,
    /// It names a different commit: GitHub served a tree nobody asked for.
    Mismatch(String),
    /// It carries no commit id at all. An archive layout we do not recognise,
    /// so this check has nothing to say and the build must fail closed.
    Unknown,
}

/// A codeload archive requested by commit id unpacks into `<repo>-<sha>`.
///
/// That suffix is produced by GitHub from the ref in the URL, so finding our
/// own commit there is evidence that the returned archive has the requested
/// provenance - unlike a digest this machine computed from those same bytes.
/// It is a provenance/layout check, not a cryptographic signature; the HTTPS
/// connection and the exact commit request provide the transport boundary.
fn archive_commit_check(source_root: &Path, expected: &str) -> ArchiveCommitCheck {
    let Some(name) = source_root.file_name().and_then(|name| name.to_str()) else {
        return ArchiveCommitCheck::Unknown;
    };
    let Some((_, suffix)) = name.rsplit_once('-') else {
        return ArchiveCommitCheck::Unknown;
    };
    let suffix = suffix.to_ascii_lowercase();
    if validate_commit_sha(&suffix).is_err() {
        return ArchiveCommitCheck::Unknown;
    }
    if suffix == expected.trim().to_ascii_lowercase() {
        ArchiveCommitCheck::Matches
    } else {
        ArchiveCommitCheck::Mismatch(suffix)
    }
}

fn find_source_root(extracted: &Path) -> Result<PathBuf, String> {
    if extracted.join("CMakeLists.txt").is_file() {
        return Ok(extracted.to_path_buf());
    }
    let mut roots = Vec::new();
    let entries = fs::read_dir(extracted).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() && entry.path().join("CMakeLists.txt").is_file() {
            roots.push(entry.path());
        }
    }
    match roots.as_slice() {
        [root] => Ok(root.clone()),
        [] => Err("llama.cpp source archive has no top-level CMakeLists.txt".into()),
        _ => Err("llama.cpp source archive has multiple possible source roots".into()),
    }
}

fn find_built_runtime_dir(build_root: &Path) -> Result<PathBuf, String> {
    let candidates = [
        build_root.join("bin").join("Release"),
        build_root.join("bin"),
        build_root.join("Release"),
    ];
    if let Some(candidate) = candidates
        .iter()
        .find(|candidate| has_runtime_binaries(candidate))
    {
        return Ok(candidate.clone());
    }

    let mut pending = vec![(build_root.to_path_buf(), 0_u32)];
    let mut visited = 0_usize;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 8 || visited >= 4096 {
            continue;
        }
        visited += 1;
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            if has_runtime_binaries(&path) {
                return Ok(path);
            }
            pending.push((path, depth + 1));
        }
    }
    Err(format!(
        "CMake completed but {} or {} was not found in the build output",
        server_executable_name(),
        bench_executable_name()
    ))
}

fn has_runtime_binaries(directory: &Path) -> bool {
    directory.join(server_executable_name()).is_file()
        && directory.join(bench_executable_name()).is_file()
}

fn copy_runtime_tree(
    source: &Path,
    destination: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    let entries = fs::read_dir(source).map_err(|error| error.to_string())?;
    for entry in entries {
        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".into());
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("runtime build output contains a symbolic link".into());
        }
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_runtime_tree(&path, &target, cancel)?;
        } else {
            fs::copy(&path, &target).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            fs::set_permissions(&target, metadata.permissions())
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn msvc_runtime_directory_has_dll(directory: &Path, expected: &str) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name == expected {
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn msvc_crt_has_required_files(directory: &Path) -> bool {
    msvc_runtime_directory_has_dll(directory, "msvcp140.dll")
        && msvc_runtime_directory_has_dll(directory, "vcruntime140.dll")
}

#[cfg(windows)]
fn msvc_openmp_has_required_files(directory: &Path) -> bool {
    msvc_runtime_directory_has_dll(directory, "vcomp140.dll")
}

#[cfg(windows)]
fn is_msvc_runtime_library_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("msvcp140")
        || name.starts_with("vcruntime140")
        || name.starts_with("vcomp140")
        || name.starts_with("concrt140")
}

#[cfg(windows)]
fn msvc_runtime_directory_is_candidate(directory: &Path) -> bool {
    msvc_crt_has_required_files(directory) || msvc_openmp_has_required_files(directory)
}

#[cfg(windows)]
fn path_has_directory(path: &Path, expected: &str) -> bool {
    path.ancestors().any(|ancestor| {
        ancestor
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(expected))
    })
}

#[cfg(windows)]
fn find_msvc_runtime_directories(
    root: &Path,
    architecture: &str,
    depth: u32,
    matches: &mut Vec<PathBuf>,
) {
    if depth > 5 || !root.is_dir() {
        return;
    }
    if path_has_directory(root, architecture) && msvc_runtime_directory_is_candidate(root) {
        matches.push(root.to_path_buf());
    }
    let mut directories = fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            (metadata.is_dir() && !metadata.file_type().is_symlink()).then_some(path)
        })
        .collect::<Vec<_>>();
    directories.sort();
    for directory in directories {
        find_msvc_runtime_directories(&directory, architecture, depth + 1, matches);
    }
}

#[cfg(windows)]
fn locate_msvc_runtime_directories() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = std::env::var_os("VCToolsRedistDir").map(PathBuf::from) {
        roots.push(root);
    }
    if let Some(cl) = locate_tool("cl") {
        if let Some(vc_root) = cl.ancestors().find(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("VC"))
        }) {
            roots.push(vc_root.join("Redist").join("MSVC"));
        }
    }
    roots.dedup();
    let mut directories = Vec::new();
    for root in roots {
        find_msvc_runtime_directories(&root, bundle_architecture(), 0, &mut directories);
    }
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        let system32 = PathBuf::from(system_root).join("System32");
        if msvc_runtime_directory_is_candidate(&system32) {
            directories.push(system32);
        }
    }
    directories.sort_by(|left, right| right.cmp(left));
    directories.dedup();
    directories
}

#[cfg(windows)]
fn locate_msvc_crt_directory() -> Option<PathBuf> {
    locate_msvc_runtime_directories()
        .into_iter()
        .find(|directory| msvc_crt_has_required_files(directory))
}

/// MSVC's import libraries are needed to build, but its CRT DLLs are not
/// copied beside a normal CMake target. Include the redistributable beside
/// every Windows bundle so a fresh PC does not need the VC++ Redistributable
/// installer just to start llama-server.
#[cfg(windows)]
fn copy_msvc_runtime_dependencies(
    destination: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let sources = locate_msvc_runtime_directories();
    if sources.is_empty() && msvc_crt_has_required_files(destination) {
        return Ok(());
    }
    if sources.is_empty() {
        return Err(
            "could not locate the MSVC C/C++ runtime redistributable. Install the Visual Studio C++ workload with its redistributable component, then rebuild the PR runtime.".to_string(),
        );
    }
    for source in sources {
        let entries = fs::read_dir(&source).map_err(|error| error.to_string())?;
        for entry in entries {
            if cancel.load(Ordering::Acquire) {
                return Err("runtime install cancelled".into());
            }
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            let is_dll = path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"));
            if !metadata.is_file() || metadata.file_type().is_symlink() || !is_dll {
                continue;
            }
            if path_has_directory(&source, "System32")
                && !is_msvc_runtime_library_name(&entry.file_name().to_string_lossy())
            {
                continue;
            }
            let target = destination.join(entry.file_name());
            if target.exists() {
                continue;
            }
            fs::copy(&path, &target).map_err(|error| {
                format!(
                    "failed to package the MSVC runtime library {}: {error}",
                    path.display()
                )
            })?;
        }
    }
    if !msvc_crt_has_required_files(destination) {
        return Err("the MSVC redistributable directory contained no usable runtime DLLs; the PR was not activated.".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn copy_msvc_runtime_dependencies(
    _destination: &Path,
    _cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    Ok(())
}

fn backend_sdk_roots(backend: &str) -> Vec<PathBuf> {
    let variables: &[&str] = match backend {
        "cuda" => &["CUDA_PATH", "CUDA_HOME", "CUDA_TOOLKIT_ROOT_DIR"],
        "rocm" => &["HIP_PATH", "ROCM_PATH"],
        _ => &[],
    };
    let mut roots = Vec::new();
    for variable in variables {
        if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
            if root.is_dir() && !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    let compiler_root = match backend {
        "cuda" => sdk_root_from_tool("nvcc"),
        "rocm" => sdk_root_from_tool("hipcc"),
        _ => None,
    };
    if let Some(root) = compiler_root.filter(|root| root.is_dir()) {
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

fn is_backend_runtime_library(backend: &str, file_name: &str) -> bool {
    let name = file_name.to_ascii_lowercase();
    let dynamic = name.ends_with(".dll")
        || name.contains(".so.")
        || name.ends_with(".so")
        || name.ends_with(".dylib");
    if !dynamic {
        return false;
    }
    let prefixes: &[&str] = match backend {
        "cuda" => &[
            "cudart",
            "libcudart",
            "cublas",
            "libcublas",
            "nvrtc",
            "libnvrtc",
            "nvjitlink",
            "libnvjitlink",
            "nvfatbin",
            "libnvfatbin",
            "nvblas",
            "libnvblas",
        ],
        "rocm" => &[
            "amdhip64",
            "libamdhip64",
            "hiprtc",
            "libhiprtc",
            "hipblas",
            "libhipblas",
            "hipblaslt",
            "libhipblaslt",
            "rocblas",
            "librocblas",
            "rocsolver",
            "librocsolver",
            "hsa-runtime64",
            "libhsa-runtime64",
            "amd_comgr",
            "libamd_comgr",
            "rocprofiler-register",
            "librocprofiler-register",
        ],
        _ => &[],
    };
    prefixes.iter().any(|prefix| name.starts_with(prefix))
}

fn directory_has_files(directory: &Path) -> bool {
    fs::read_dir(directory)
        .map(|entries| {
            entries.flatten().any(|entry| {
                fs::symlink_metadata(entry.path())
                    .map(|metadata| metadata.is_file())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn directory_has_named_runtime_library(destination: &Path, prefix: &str) -> bool {
    fs::read_dir(destination)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                    return false;
                };
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return false;
                }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                let name = name.strip_prefix("lib").unwrap_or(&name);
                name.starts_with(prefix)
            })
        })
        .unwrap_or(false)
}

fn rocm_runtime_dependencies_complete(destination: &Path) -> bool {
    if !directory_has_named_runtime_library(destination, "amdhip64")
        || (!directory_has_named_runtime_library(destination, "hipblas")
            && !directory_has_named_runtime_library(destination, "rocblas"))
    {
        return false;
    }
    let rocblas_ok = !directory_has_named_runtime_library(destination, "rocblas")
        || directory_has_files(&destination.join("rocblas").join("library"));
    let hipblaslt_ok = !directory_has_named_runtime_library(destination, "hipblaslt")
        || directory_has_files(&destination.join("hipblaslt").join("library"));
    rocblas_ok && hipblaslt_ok
}

fn backend_runtime_dependencies_complete(backend: &str, destination: &Path) -> bool {
    match backend {
        "rocm" => rocm_runtime_dependencies_complete(destination),
        "cuda" => {
            directory_has_named_runtime_library(destination, "cudart")
                && directory_has_named_runtime_library(destination, "cublas")
        }
        _ => true,
    }
}

fn count_files_recursive(directory: &Path) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    entries.flatten().fold(0, |count, entry| {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            return count;
        };
        if metadata.is_dir() {
            count.saturating_add(count_files_recursive(&path))
        } else if metadata.is_file() {
            count.saturating_add(1)
        } else {
            count
        }
    })
}

/// Copy redistributable vendor runtime libraries beside the PR binaries. The
/// build output's backend plugin is not enough: CUDA/HIP shared libraries are
/// supplied by their SDK and are otherwise found only on the build machine.
/// The host GPU driver is intentionally excluded because it is supplied by
/// the operating system and cannot safely be redistributed.
fn copy_backend_runtime_dependencies(
    backend: &str,
    destination: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    if !matches!(backend, "cuda" | "rocm") {
        return Ok(());
    }
    // Exporting an already-portable runtime on a PC that no longer has the
    // original SDK should still work. Source builds take the other path below
    // because their destination does not yet contain the required libraries.
    if backend_runtime_dependencies_complete(backend, destination) {
        return Ok(());
    }
    let roots = backend_sdk_roots(backend);
    let mut found = 0_usize;
    let mut found_data = 0_usize;
    for root in &roots {
        for relative in ["bin", "lib", "lib64", "lib/x64"] {
            let directory = root.join(relative);
            let Ok(entries) = fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if cancel.load(Ordering::Acquire) {
                    return Err("runtime install cancelled".into());
                }
                let path = entry.path();
                let Ok(metadata) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || !is_backend_runtime_library(backend, &entry.file_name().to_string_lossy())
                {
                    continue;
                }
                found += 1;
                let target = destination.join(entry.file_name());
                if target.exists() {
                    continue;
                }
                fs::copy(&path, &target).map_err(|error| {
                    format!(
                        "failed to package the {backend} runtime library {}: {error}",
                        path.display()
                    )
                })?;
                #[cfg(unix)]
                fs::set_permissions(&target, metadata.permissions())
                    .map_err(|error| error.to_string())?;
            }
        }
        if backend == "rocm" {
            for (relative, target_name) in [
                ("bin/rocblas", "rocblas"),
                ("lib/rocblas", "rocblas"),
                ("bin/hipblaslt", "hipblaslt"),
                ("lib/hipblaslt", "hipblaslt"),
            ] {
                let source = root.join(relative);
                if !source.is_dir() {
                    continue;
                }
                let target = destination.join(target_name);
                copy_runtime_tree(&source, &target, cancel)?;
                found_data = found_data.saturating_add(count_files_recursive(&target));
            }
        }
    }
    if found == 0 {
        return Err(format!(
            "could not package the {backend} runtime libraries from the installed SDK. Keep the SDK root configured (HIP_PATH/ROCM_PATH for ROCm, CUDA_PATH/CUDA_HOME for CUDA) and retry; the PR was not activated."
        ));
    }
    if backend == "rocm" && !rocm_runtime_dependencies_complete(destination) {
        return Err(
            "could not package the ROCm rocblas/hipblaslt library data needed at runtime. The HIP SDK's bin/rocblas and bin/hipblaslt directories must be available; the PR was not activated.".into(),
        );
    }
    if backend == "rocm" && found_data == 0 {
        return Err(
            "the ROCm SDK exposed runtime DLLs but no rocblas/hipblaslt kernel data; the PR was not activated.".into(),
        );
    }
    Ok(())
}

async fn download_to_file(
    progress: ProgressSink<'_>,
    phase: &str,
    url: &str,
    path: &Path,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let response = download_http()
        .get(url)
        .send()
        .await
        .map_err(|error| format!("runtime download failed: {error}"))?;
    validate_download_url(response.url().as_str())?;
    if !response.status().is_success() {
        return Err(format!(
            "runtime download returned HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ARCHIVE_BYTES)
    {
        return Err("runtime archive exceeds the configured size limit".into());
    }
    let total = response.content_length().unwrap_or(0);
    let mut output = tokio::fs::File::create(path)
        .await
        .map_err(|error| error.to_string())?;
    let mut received = 0_u64;
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|error| format!("runtime download stream failed: {error}"))?
    {
        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".into());
        }
        received = received.saturating_add(chunk.len() as u64);
        if received > MAX_ARCHIVE_BYTES {
            return Err("runtime archive exceeds the configured size limit".into());
        }
        write_download_chunk(&mut output, &chunk).await?;
        progress(phase, received as f64, total as f64);
    }
    output.flush().await.map_err(|error| error.to_string())?;
    Ok(())
}

async fn write_download_chunk(output: &mut tokio::fs::File, chunk: &[u8]) -> Result<(), String> {
    output
        .write_all(chunk)
        .await
        .map_err(|error| error.to_string())
}

fn verify_runtime_files(staging: &Path) -> Result<(), String> {
    let server = staging.join(server_executable_name());
    let bench = staging.join(bench_executable_name());
    if !server.is_file() || !bench.is_file() {
        return Err(format!(
            "runtime archive is missing {} or {}",
            server_executable_name(),
            bench_executable_name()
        ));
    }
    Ok(())
}

async fn preflight_staged_runtime(
    staging: &Path,
    progress: ProgressSink<'_>,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<RuntimeVersion>, String> {
    let checks: [(&str, &[&str], &str); 4] = [
        (
            server_executable_name(),
            &["--version"],
            "llama-server --version",
        ),
        (server_executable_name(), &["--help"], "llama-server --help"),
        (
            server_executable_name(),
            &["--list-devices"],
            "llama-server --list-devices",
        ),
        (bench_executable_name(), &["--help"], "llama-bench --help"),
    ];
    let total = checks.len() as f64;
    let mut version = None;
    // Do not let a build host's CUDA/ROCm/Vulkan SDK or PATH hide a missing
    // sidecar. This makes the preflight answer the question that matters:
    // would the activated runtime work on a fresh PC with only its host GPU
    // driver installed?
    let environment = staged_runtime_environment(staging);
    for (index, (name, args, label)) in checks.into_iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".into());
        }
        progress("preflight", index as f64, total);
        let executable = staging.join(name);
        let result = run_probe_with_cancel_and_environment(
            &executable,
            args,
            STAGED_PREFLIGHT_TIMEOUT,
            Some(cancel),
            &environment,
        )
        .await;
        if !result.success {
            let diagnostic = result
                .diagnostic
                .unwrap_or_else(|| "probe returned a non-success status".into());
            return Err(format!(
                "staged runtime preflight failed for {label}: {diagnostic}"
            ));
        }
        if args == ["--version"] {
            version = parse_runtime_version(&result.text);
        }
    }
    progress("preflight", total, total);
    Ok(version)
}

fn replace_runtime(staging: &Path, destination: &Path) -> Result<(), String> {
    replace_runtime_with(staging, destination, remove_tree_bounded)
}

fn replace_runtime_with<F>(
    staging: &Path,
    destination: &Path,
    cleanup_backup: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let parent = destination
        .parent()
        .ok_or_else(|| "runtime destination has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let backup = parent.join(format!(
        ".{}.backup-{}",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        Uuid::new_v4().simple()
    ));
    let had_old = destination.exists();
    if had_old {
        fs::rename(destination, &backup)
            .map_err(|error| format!("failed to stage old runtime: {error}"))?;
    }
    if let Err(error) = fs::rename(staging, destination) {
        if had_old {
            if let Err(rollback) = fs::rename(&backup, destination) {
                return Err(format!(
                    "failed to activate runtime: {error}; rollback also failed: {rollback}"
                ));
            }
        }
        return Err(format!("failed to activate runtime: {error}"));
    }
    if had_old {
        let _ = cleanup_backup(&backup);
    }
    Ok(())
}

fn extract(zip_path: &Path, dest: &Path, cancel: &Arc<AtomicBool>) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    let file = fs::File::open(zip_path).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("runtime archive contains too many entries".into());
    }
    let mut extracted_bytes = 0_u64;
    for index in 0..archive.len() {
        if cancel.load(Ordering::Acquire) {
            return Err("runtime install cancelled".into());
        }
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        if entry
            .unix_mode()
            .is_some_and(|mode| (mode & 0o170000) == 0o120000)
        {
            return Err("runtime archive contains a symbolic link".into());
        }
        let relative = entry
            .enclosed_name()
            .ok_or("runtime archive contains an unsafe path")?;
        let output = dest.join(relative);
        if !output.starts_with(dest) {
            return Err("runtime archive path escapes staging directory".into());
        }
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        let declared_size = entry.size();
        extracted_bytes = extracted_bytes
            .checked_add(declared_size)
            .ok_or("runtime archive expanded size overflow")?;
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err("runtime archive expands beyond the configured size limit".into());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut destination = fs::File::create(&output).map_err(|error| error.to_string())?;
        // A corrupt ZIP can lie about an entry's uncompressed size. Limit the
        // actual copy to one byte beyond the declaration so the later mismatch
        // check cannot be turned into an unbounded disk-fill operation.
        let mut source = BufReader::new(entry).take(declared_size.saturating_add(1));
        let copied =
            std::io::copy(&mut source, &mut destination).map_err(|error| error.to_string())?;
        if copied != declared_size {
            return Err("runtime archive entry size changed while extracting".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Architecture list used wherever a test only cares about the other
    /// configure options; the CUDA policy has its own tests.
    const TEST_CUDA_ARCHITECTURES: &str = "89-real;89-virtual";

    fn test_directory(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "llama-board-{prefix}-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ))
    }

    fn test_source() -> RuntimeSource {
        RuntimeSource {
            pull_request: 27342,
            repository: "contributor/llama.cpp".into(),
            head_ref: "feature".into(),
            author: "contributor".into(),
            state: "open".into(),
            fork: true,
            commit: "0123456789abcdef0123456789abcdef01234567".into(),
            archive_sha256: String::new(),
            commit_check: "github-actions-checkout-ref".into(),
            url: "https://github.com/ggml-org/llama.cpp/pull/27342".into(),
        }
    }

    fn test_bundle_manifest(root: &Path) -> RuntimeBundleManifest {
        let files = collect_runtime_files(root)
            .expect("collect test runtime files")
            .into_iter()
            .map(|(path, file, bytes)| RuntimeBundleFile {
                path,
                bytes,
                sha256: sha256_file(&file).expect("hash test runtime file"),
            })
            .collect();
        RuntimeBundleManifest {
            format: RUNTIME_BUNDLE_FORMAT,
            backend: "cpu".into(),
            build: "pr27342".into(),
            platform: release_platform().into(),
            architecture: bundle_architecture().into(),
            version: None,
            source: Some(test_source()),
            files,
        }
    }

    fn write_test_archive(path: &Path, name: &str, contents: &[u8]) {
        use std::io::Write;
        let file = fs::File::create(path).expect("create test archive");
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .expect("start test archive entry");
        archive
            .write_all(contents)
            .expect("write test archive entry");
        archive.finish().expect("finish test archive");
    }

    #[test]
    fn bundle_manifest_paths_are_normalized_and_safe() {
        for valid in ["llama-server.exe", "rocblas/library/kernel.bin"] {
            assert!(validate_bundle_manifest_path(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "",
            "../outside.dll",
            "nested/../../outside.dll",
            "nested\\outside.dll",
            "C:/outside.dll",
            "/outside.dll",
        ] {
            assert!(validate_bundle_manifest_path(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn bundle_file_manifest_round_trips_with_source_provenance() {
        let root = test_directory("bundle-roundtrip");
        fs::create_dir_all(&root).expect("create test runtime");
        fs::write(root.join(server_executable_name()), b"server").expect("write server");
        fs::write(root.join(bench_executable_name()), b"bench").expect("write bench");
        let source = test_source();
        write_source_manifest(&root, &source).expect("write source manifest");
        let manifest = test_bundle_manifest(&root);
        validate_bundle_manifest(&manifest).expect("validate test manifest");
        verify_bundle_files(&root, &manifest).expect("verify test bundle");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bundle_file_verification_rejects_missing_source_manifest() {
        let root = test_directory("bundle-missing-source");
        fs::create_dir_all(&root).expect("create test runtime");
        fs::write(root.join(server_executable_name()), b"server").expect("write server");
        fs::write(root.join(bench_executable_name()), b"bench").expect("write bench");
        let error = verify_bundle_files(&root, &test_bundle_manifest(&root))
            .expect_err("missing source manifest must be rejected");
        assert!(error.contains("source provenance"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_extraction_rejects_path_traversal() {
        let root = test_directory("bundle-traversal");
        let archive = root.join("input.zip");
        let destination = root.join("extracted");
        fs::create_dir_all(&root).expect("create archive test root");
        write_test_archive(&archive, "../outside.dll", b"unsafe");
        let cancel = Arc::new(AtomicBool::new(false));
        let error =
            extract(&archive, &destination, &cancel).expect_err("path traversal must be rejected");
        assert!(error.contains("unsafe path") || error.contains("escapes"));
        assert!(!root.join("outside.dll").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_extraction_accepts_a_normalized_runtime_root() {
        let root = test_directory("bundle-extract");
        let archive = root.join("input.zip");
        let destination = root.join("extracted");
        fs::create_dir_all(&root).expect("create archive test root");
        write_test_archive(&archive, "pr27342-cpu/llama-server.exe", b"server");
        let cancel = Arc::new(AtomicBool::new(false));
        extract(&archive, &destination, &cancel).expect("safe archive should extract");
        assert_eq!(
            fs::read(destination.join("pr27342-cpu/llama-server.exe")).expect("read extracted"),
            b"server"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_release_object_assets() {
        let body = r#"{
            "tag_name": "b10603",
            "assets": [{
                "name": "llama-b10603-bin-win-vulkan-x64.zip",
                "browser_download_url": "https://example.invalid/vulkan.zip"
            }]
        }"#;
        let assets = parse_release_assets(body).expect("release object should decode");
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].name, "llama-b10603-bin-win-vulkan-x64.zip");
    }

    #[test]
    fn github_rate_limit_error_is_actionable() {
        let error = api_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"message":"API rate limit exceeded"}"#,
        );
        assert!(error.contains("GitHub API 403"));
        assert!(error.contains("rate limit"));
    }

    #[tokio::test]
    async fn async_download_writer_writes_chunks_without_sync_file_calls() {
        let path = std::env::temp_dir().join(format!(
            "llama-board-runtime-download-{}-{}.part",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let mut file = tokio::fs::File::create(&path)
            .await
            .expect("create temp file");
        write_download_chunk(&mut file, b"runtime")
            .await
            .expect("write chunk");
        file.flush().await.expect("flush chunk");
        drop(file);
        assert_eq!(fs::read(&path).expect("read temp file"), b"runtime");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn runtime_identifiers_reject_traversal_and_invalid_values() {
        assert!(validate_runtime_identifiers("../outside", "b10603").is_err());
        assert!(validate_runtime_identifiers("vulkan", "../../outside").is_err());
        assert!(validate_runtime_identifiers("future-backend", "b10603").is_ok());
        assert!(validate_runtime_identifiers("vulkan", "b10603").is_ok());
        assert!(validate_runtime_identifiers("cuda", "pr27342").is_ok());
        assert!(validate_runtime_identifiers("cuda", "pr0").is_err());
        assert!(validate_runtime_identifiers("cuda", "pr").is_err());
    }

    #[test]
    fn pull_request_inputs_normalize_to_a_safe_build_id() {
        assert_eq!(pull_request_build_id("27342").unwrap(), "pr27342");
        assert_eq!(pull_request_build_id("#27342").unwrap(), "pr27342");
        assert_eq!(
            pull_request_build_id("https://github.com/ggml-org/llama.cpp/pull/27342/files")
                .unwrap(),
            "pr27342"
        );
        for input in [
            "",
            "https://github.com/other/llama.cpp/pull/27342",
            "http://github.com/ggml-org/llama.cpp/pull/27342",
            "https://github.com/ggml-org/llama.cpp/issues/27342",
            "https://example.com/ggml-org/llama.cpp/pull/27342",
            "https://github.com/ggml-org/llama.cpp/pull/not-a-number",
        ] {
            assert!(pull_request_build_id(input).is_err(), "{input}");
        }
    }

    #[test]
    fn source_build_options_select_exactly_the_requested_backend() {
        let source = Path::new("source");
        let build = Path::new("build");
        let cuda =
            source_build_configure_args("cuda", source, build, TEST_CUDA_ARCHITECTURES).unwrap();
        assert!(cuda.iter().any(|arg| arg == "-DGGML_CUDA=ON"));
        assert!(!cuda.iter().any(|arg| arg == "-DGGML_VULKAN=ON"));
        let cpu =
            source_build_configure_args("cpu", source, build, TEST_CUDA_ARCHITECTURES).unwrap();
        assert!(cpu.iter().any(|arg| arg == "-DGGML_CPU=ON"));
        assert!(
            source_build_configure_args("unknown", source, build, TEST_CUDA_ARCHITECTURES).is_err()
        );
    }

    #[test]
    fn vendor_runtime_packaging_matches_sdk_libraries_but_not_host_drivers() {
        for name in ["cudart64_12.dll", "libcublas.so.12.4", "libnvJitLink.so.12"] {
            assert!(is_backend_runtime_library("cuda", name), "{name}");
        }
        for name in [
            "amdhip64.dll",
            "librocblas.so.4",
            "hipblaslt.dll",
            "libhsa-runtime64.so.1",
        ] {
            assert!(is_backend_runtime_library("rocm", name), "{name}");
        }
        for name in ["nvcuda.dll", "libcuda.so.1", "libamdvlk64.so"] {
            assert!(!is_backend_runtime_library("cuda", name), "{name}");
            assert!(!is_backend_runtime_library("rocm", name), "{name}");
        }
    }

    #[test]
    fn cmake_parallel_environment_is_not_overridden_by_a_bare_parallel_flag() {
        let root = Path::new("build");
        let default_args = source_build_args_with_parallelism(root, None);
        assert_eq!(
            default_args
                .iter()
                .filter(|arg| *arg == "--parallel")
                .count(),
            1
        );
        assert!(!default_args.iter().any(|arg| arg == "4"));

        let capped = source_build_args_with_parallelism(root, Some(" 4 "));
        let parallel = capped.iter().position(|arg| arg == "--parallel").unwrap();
        assert_eq!(capped.get(parallel + 1).map(String::as_str), Some("4"));

        // An invalid environment value must not accidentally turn into the
        // full-core default through a bare --parallel flag.
        let invalid = source_build_args_with_parallelism(root, Some("all-cores"));
        assert!(!invalid.iter().any(|arg| arg == "--parallel"));
        assert!(valid_parallelism("1"));
        assert!(!valid_parallelism("0"));
        assert!(!valid_parallelism("4 cores"));
    }

    #[test]
    fn build_environment_puts_the_selected_tool_directory_first() {
        let tool = Path::new("test-toolchain").join("bin").join("cmake");
        let environment = build_environment_with_tool(&tool);
        let path = environment
            .iter()
            .find(|(key, _)| key == OsStr::new("PATH"))
            .map(|(_, value)| value.clone())
            .expect("build environment should include PATH");
        assert_eq!(
            std::env::split_paths(&path).next(),
            tool.parent().map(Path::to_path_buf)
        );
    }

    #[test]
    fn rocm_build_environment_prefers_the_cxx_driver_for_hip() {
        if locate_tool("hipcc").is_none() {
            return;
        }
        let environment = build_environment_for_backend(Path::new("cmake"), "rocm");
        let hipcxx = environment
            .iter()
            .find(|(name, _)| name == OsStr::new("HIPCXX"))
            .map(|(_, value)| value.clone())
            .expect("a complete ROCm SDK should provide clang++ for HIP");
        assert!(
            hipcxx
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("clang++"),
            "HIPCXX must be a C++ compiler: {hipcxx:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_clang_environment_contains_sdk_linker_inputs() {
        let Some(cl) = locate_tool("cl") else {
            // Linux/macOS CI and Windows machines without the optional source
            // build toolchain do not exercise this integration check.
            return;
        };
        let mut environment = build_environment();
        merge_visual_studio_environment(&mut environment, &cl);
        let include = environment_value(&environment, "INCLUDE")
            .expect("Visual Studio should provide INCLUDE for clang on Windows");
        assert!(
            std::env::split_paths(&include).any(|path| path.is_dir()),
            "INCLUDE should contain an existing directory"
        );
        let libraries = environment_value(&environment, "LIB")
            .expect("Visual Studio should provide LIB for clang on Windows");
        assert!(
            std::env::split_paths(&libraries).any(|path| path.join("kernel32.lib").is_file()),
            "LIB should contain the Windows SDK import libraries: {:?}",
            std::env::split_paths(&libraries).collect::<Vec<_>>()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_child_paths_do_not_use_cmd_incompatible_verbatim_prefixes() {
        assert_eq!(
            strip_windows_verbatim_prefix(PathBuf::from(r"\\?\C:\ROCm\bin")),
            PathBuf::from(r"C:\ROCm\bin")
        );
        assert_eq!(
            strip_windows_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\bin")),
            PathBuf::from(r"\\server\share\bin")
        );
        let ordinary = PathBuf::from(r"C:\ROCm\bin");
        assert_eq!(strip_windows_verbatim_prefix(ordinary.clone()), ordinary);
    }

    #[test]
    fn source_archive_is_pinned_to_the_pr_head_commit() {
        let source = RuntimeSource {
            pull_request: 27342,
            repository: "ggml-org/llama.cpp".into(),
            commit: "0123456789abcdef0123456789abcdef01234567".into(),
            url: "https://github.com/ggml-org/llama.cpp/pull/27342".into(),
            ..RuntimeSource::default()
        };
        assert_eq!(
            source_archive_url(&source).unwrap(),
            "https://codeload.github.com/ggml-org/llama.cpp/zip/0123456789abcdef0123456789abcdef01234567"
        );
    }

    #[test]
    fn install_cleanup_removes_partial_archive_and_staging_directory() {
        let root = std::env::temp_dir().join(format!("llama-board-cleanup-{}", Uuid::new_v4()));
        let archive = root.join("download.zip");
        let staging = root.join("staging");
        fs::create_dir_all(&staging).expect("create staging");
        fs::write(&archive, b"partial").expect("create archive");
        let cleanup = InstallCleanup::new(archive.clone(), staging.clone());
        drop(cleanup);
        assert!(!archive.exists());
        assert!(!staging.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn orphan_sweep_removes_only_old_exactly_named_work() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-orphan-sweep-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let downloads = root.join("downloads");
        let runtimes = root.join("runtimes");
        fs::create_dir_all(&downloads).expect("create downloads");
        fs::create_dir_all(&runtimes).expect("create runtimes");
        let old_archive = downloads.join(".0123456789ab-llama-b10603-bin-win-cpu-x64.zip");
        fs::write(&old_archive, b"partial archive").expect("create stale archive");
        let old_workspace = downloads.join(".0123456789ab-pr27342-cuda");
        let old_staging = runtimes.join(".pr27342-cuda.staging-0123456789ab");
        let old_backup = runtimes.join(".pr27342-cuda.backup-0123456789abcdef0123456789abcdef");
        for path in [&old_workspace, &old_staging, &old_backup] {
            fs::create_dir_all(path).expect("create stale work");
        }
        // Simulate a timestamp well past the conservative age threshold without
        // requiring a platform-specific file-time dependency.
        let old_now = SystemTime::now() + ORPHAN_SWEEP_MAX_AGE + Duration::from_secs(1);
        sweep_orphaned_work_in(&downloads, &runtimes, old_now);
        assert!(!old_archive.exists());
        assert!(!old_workspace.exists());
        assert!(!old_staging.exists());
        assert!(!old_backup.exists());

        let fresh_workspace = downloads.join(".0123456789ab-pr27342-cuda");
        let user_workspace = downloads.join(".my-project-pr27342-cuda");
        let user_archive = downloads.join(".not-a-download.zip");
        let malformed = runtimes.join(".pr27342-cuda.staging-not-a-nonce");
        let managed = runtimes.join("pr27342-cuda");
        fs::write(&user_archive, b"user file").expect("create user archive");
        for path in [&fresh_workspace, &user_workspace, &malformed, &managed] {
            fs::create_dir_all(path).expect("create preserved work");
        }
        sweep_orphaned_work_in(&downloads, &runtimes, SystemTime::now());
        for path in [&fresh_workspace, &user_workspace, &malformed, &managed] {
            assert!(path.exists(), "{path:?} must be preserved");
        }
        assert!(user_archive.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn orphan_sweep_name_allowlist_does_not_match_user_paths() {
        assert!(is_pr_download_workspace_name(".0123456789ab-pr27342-cuda"));
        assert!(is_runtime_staging_or_backup_name(
            ".pr27342-cuda.staging-0123456789ab"
        ));
        assert!(is_runtime_staging_or_backup_name(
            ".pr27342-cuda.backup-0123456789abcdef0123456789abcdef"
        ));
        assert!(is_runtime_download_file_name(
            ".0123456789ab-llama-b10603-bin-win-cpu-x64.zip"
        ));
        for name in [
            ".project-pr27342-cuda",
            ".0123456789ab-b10638-cuda",
            ".0123456789ab-pr27342-future",
            ".pr27342-cuda.staging-not-hex",
            ".pr27342-cuda.backup-0123",
            ".pr27342-future.staging-0123456789ab",
            "pr27342-cuda",
        ] {
            assert!(
                !is_pr_download_workspace_name(name) && !is_runtime_staging_or_backup_name(name),
                "{name} must not be sweepable"
            );
        }
        assert!(!is_runtime_download_file_name(".not-a-download.zip"));
        assert!(!is_runtime_download_file_name("llama-b10603.zip"));
    }

    #[test]
    fn orphan_sweep_ignores_a_locked_directory_removal_failure() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-orphan-locked-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let downloads = root.join("downloads");
        let runtimes = root.join("runtimes");
        fs::create_dir_all(&downloads).expect("create downloads");
        fs::create_dir_all(&runtimes).expect("create runtimes");
        let stale = downloads.join(".0123456789ab-pr27342-cuda");
        fs::create_dir_all(&stale).expect("create stale workspace");

        let now = SystemTime::now() + ORPHAN_SWEEP_MAX_AGE + Duration::from_secs(1);
        // A locked directory on Windows (or a transient filesystem error on
        // Unix) is expected to remain for a later sweep, not abort startup.
        sweep_orphaned_work_in_with(&downloads, &runtimes, now, |_| {
            Err("simulated locked directory".into())
        });
        assert!(
            stale.exists(),
            "failed cleanup must leave the directory alone"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn replacement_succeeds_when_old_backup_cleanup_fails() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-replace-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let destination = root.join("runtime");
        let staging = root.join("staging");
        fs::create_dir_all(&destination).expect("create old runtime");
        fs::write(destination.join("version"), b"old").expect("write old runtime");
        fs::create_dir_all(&staging).expect("create new runtime");
        fs::write(staging.join("version"), b"new").expect("write new runtime");

        let result = replace_runtime_with(&staging, &destination, |_| {
            Err("simulated backup cleanup failure".into())
        });

        assert!(result.is_ok());
        assert_eq!(
            fs::read(destination.join("version")).expect("read active runtime"),
            b"new"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn release_asset_filename_must_be_a_safe_zip_basename() {
        assert!(validate_asset_file_name("llama-b10603-bin-win-vulkan-x64.zip").is_ok());
        assert!(validate_asset_file_name("../runtime.zip").is_err());
        assert!(validate_asset_file_name("runtime.tar.gz").is_err());
        assert!(validate_asset_file_name("runtime file.zip").is_err());
    }

    #[test]
    fn release_asset_digest_is_preserved() {
        let body = r#"{
            "assets": [{
                "name": "llama-b10603-bin-win-vulkan-x64.zip",
                "browser_download_url": "https://example.invalid/vulkan.zip",
                "digest": "sha256:0123456789abcdef"
            }]
        }"#;
        let assets = parse_release_assets(body).expect("release object should decode");
        assert_eq!(assets[0].digest.as_deref(), Some("sha256:0123456789abcdef"));
    }

    #[test]
    fn runtime_version_is_parsed_from_the_llama_server_banner() {
        let parsed = parse_runtime_version(
            "version: 0.3.0-dev (build 10638, commit bf9421646)\nbuilt with Clang 20.1.8",
        )
        .expect("banner should parse");
        assert_eq!(parsed.semver, "0.3.0-dev");
        assert_eq!(parsed.build, 10638);
        assert_eq!(parsed.commit, "bf9421646");

        let released = parse_runtime_version("version: 0.2.0 (build 10603, commit c060ca974)")
            .expect("banner should parse");
        assert_eq!(released.semver, "0.2.0");
        assert_eq!(released.build, 10603);
    }

    #[test]
    fn unparseable_version_banners_are_rejected() {
        for text in [
            "",
            "llama-server",
            "version: (build 10638)",
            "version: 0.3.0-dev (commit bf9421646)",
            "version: 0.3.0-dev build 10638",
        ] {
            assert!(parse_runtime_version(text).is_none(), "{text:?}");
        }
    }

    #[test]
    fn staged_preflight_budget_dwarfs_the_interactive_probe() {
        // The first launch of a freshly extracted 100-250 MB runtime is
        // dominated by on-access virus scanning; the 8s interactive budget
        // aborts the install before llama-server reaches main().
        assert!(STAGED_PREFLIGHT_TIMEOUT >= PROBE_TIMEOUT * 10);
    }

    #[test]
    fn cuda_assets_pull_in_the_matching_cudart_sidecar() {
        assert_eq!(
            companion_asset_name("b10636", "llama-b10636-bin-win-cuda-12.4-x64.zip").as_deref(),
            Some("cudart-llama-bin-win-cuda-12.4-x64.zip")
        );
        assert_eq!(
            companion_asset_name("b10636", "llama-b10636-bin-win-cuda-13.3-x64.zip").as_deref(),
            Some("cudart-llama-bin-win-cuda-13.3-x64.zip")
        );
    }

    #[test]
    fn non_cuda_assets_have_no_sidecar() {
        for name in [
            "llama-b10636-bin-win-vulkan-x64.zip",
            "llama-b10636-bin-win-cpu-x64.zip",
            "llama-b10636-bin-win-rocm-7.14-x64.zip",
            "llama-b10636-bin-win-sycl-x64.zip",
            "llama-b10636-bin-win-openvino-2026.3-x64.zip",
        ] {
            assert_eq!(companion_asset_name("b10636", name), None, "{name}");
        }
        // A mismatched build prefix must not silently produce a sidecar name.
        assert_eq!(
            companion_asset_name("b10600", "llama-b10636-bin-win-cuda-12.4-x64.zip"),
            None
        );
    }

    #[test]
    fn companion_sidecar_names_pass_the_asset_filename_guard() {
        let name = companion_asset_name("b10636", "llama-b10636-bin-win-cuda-12.4-x64.zip")
            .expect("cuda asset should map to a sidecar");
        assert!(validate_asset_file_name(&name).is_ok());
    }

    #[test]
    fn probe_flags_ignores_dash_only_help_separators() {
        let flags = probe_flags("----- --help --ctx-size");
        assert_eq!(flags, vec!["--help", "--ctx-size"]);
    }

    #[test]
    fn preflight_requires_server_and_bench_checks() {
        assert_eq!(classify_preflight(true, true, true, true), "available");
        assert_eq!(
            classify_preflight(true, true, true, false),
            "failed preflight"
        );
        assert_eq!(
            classify_preflight(false, true, true, true),
            "failed preflight"
        );
    }

    #[tokio::test]
    async fn a_drained_stream_never_closes_the_pipe_early() {
        // The regression: capping with a take() adapter returned as soon as
        // the limit was hit, dropping the pipe under a still-running child. A
        // real CMake build then died on a broken pipe (or blocked on a full
        // one) long before it produced a binary.
        let cap = 4 * 1024;
        let (reader, mut writer) = tokio::io::duplex(1024);
        let drained = tokio::spawn(drain_stream(reader, cap, Retain::Head));
        let mut written = Vec::new();
        for index in 0..64_u8 {
            let chunk = vec![b'a' + index % 26; 1024];
            writer
                .write_all(&chunk)
                .await
                .expect("a live child must never see a closed pipe");
            written.extend_from_slice(&chunk);
        }
        drop(writer);
        let output = drained.await.expect("drain task should finish");
        assert_eq!(written.len(), 64 * 1024);
        assert_eq!(output, written[..cap]);
    }

    #[tokio::test]
    async fn a_drained_stream_keeps_the_tail_of_a_long_log() {
        let cap = 4 * 1024;
        let (reader, mut writer) = tokio::io::duplex(1024);
        let drained = tokio::spawn(drain_stream(reader, cap, Retain::Tail));
        let mut written = Vec::new();
        for index in 0..64_u8 {
            let chunk = vec![b'a' + index % 26; 1024];
            writer.write_all(&chunk).await.expect("write chunk");
            written.extend_from_slice(&chunk);
        }
        writer
            .write_all(b"fatal error C1083")
            .await
            .expect("write the diagnostic that matters");
        written.extend_from_slice(b"fatal error C1083");
        drop(writer);
        let output = drained.await.expect("drain task should finish");
        assert_eq!(output.len(), cap);
        assert_eq!(output, written[written.len() - cap..]);
    }

    #[tokio::test]
    async fn a_single_oversized_chunk_is_reduced_to_its_tail() {
        let cap = 64;
        let payload = (0..4096_u32)
            .map(|value| (value % 251) as u8)
            .collect::<Vec<_>>();
        let output = drain_stream(payload.as_slice(), cap, Retain::Tail).await;
        assert_eq!(output, payload[payload.len() - cap..]);
    }

    #[cfg(windows)]
    fn noisy_command() -> Command {
        let mut command = Command::new("cmd");
        command.args([
            "/c",
            "for /L %i in (1,1,6000) do @echo 0123456789012345678901234567890123456789012345678901234567890123",
        ]);
        command
    }

    #[cfg(not(windows))]
    fn noisy_command() -> Command {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "yes 0123456789012345678901234567890123456789012345678901234567890123 | head -n 6000",
        ]);
        command
    }

    #[tokio::test]
    async fn a_build_that_outruns_the_log_cap_still_runs_to_completion() {
        let mut command = noisy_command();
        configure_build_process_group(&mut command);
        let child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn the noisy child");
        let cancel = Arc::new(AtomicBool::new(false));
        let progress: ProgressSink = &|_, _, _| {};
        let output = supervise_build_child(
            child,
            progress,
            "building",
            "test build",
            &cancel,
            Duration::from_secs(30),
        )
        .await
        .expect("a noisy child must still be waited on successfully");
        assert!(output.status.success(), "{:?}", output.status);
        // More output than the cap was written, and only the tail was kept.
        assert_eq!(output.stdout.len(), MAX_BUILD_LOG_TAIL);
    }

    #[tokio::test]
    async fn an_abandoned_reader_still_hands_back_what_it_read() {
        // A grandchild that inherited the pipe can keep it open past the join
        // deadline. Aborting the task must not throw away the log: that is
        // exactly the case where the user needs the diagnostic.
        let log = shared_log();
        let (reader, mut writer) = tokio::io::duplex(1024);
        let task = tokio::spawn(drain_stream_into(reader, log.clone(), 4096, Retain::Tail));
        writer
            .write_all(b"fatal error C1083: cannot open include file")
            .await
            .expect("write the diagnostic that matters");
        // The writer is deliberately never dropped, so the drain never ends.
        let output = finish_build_reader(task, &log, Duration::from_millis(200)).await;
        assert_eq!(output, b"fatal error C1083: cannot open include file");
        drop(writer);
    }

    #[tokio::test]
    async fn a_finished_reader_is_joined_without_waiting_out_the_budget() {
        let log = shared_log();
        let task = tokio::spawn(drain_stream_into(
            b"configure output".as_slice(),
            log.clone(),
            4096,
            Retain::Tail,
        ));
        let started = Instant::now();
        let output = finish_build_reader(task, &log, Duration::from_secs(30)).await;
        assert_eq!(output, b"configure output");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn build_failures_report_the_end_of_the_log() {
        let mut log = "noise\n".repeat(20_000);
        log.push_str("fatal error C1083: cannot open include file");
        let detail = build_failure_detail(log.as_bytes(), b"   \n");
        assert!(detail.ends_with("fatal error C1083: cannot open include file"));
        assert!(detail.chars().count() <= MAX_BUILD_DETAIL_CHARS);
        assert!(detail.chars().count() > 100);

        let combined = build_failure_detail(b"configure output", b"ninja: build stopped");
        assert!(combined.contains("configure output"));
        assert!(combined.ends_with("ninja: build stopped"));
        assert!(build_failure_detail(b"", b"  ").is_empty());
    }

    #[test]
    fn pull_request_builds_are_limited_to_backends_with_detectable_toolchains() {
        for backend in SOURCE_BUILD_BACKENDS {
            assert!(validate_source_build_backend(backend).is_ok(), "{backend}");
            assert!(CATALOG_BACKENDS.contains(backend), "{backend}");
        }
        for backend in ["sycl", "openvino"] {
            let error = validate_source_build_backend(backend)
                .expect_err("a vendor-toolchain backend must be refused");
            assert!(error.contains(backend), "{error}");
            assert!(error.contains("not supported"), "{error}");
            assert!(error.contains("cpu, vulkan, cuda, rocm"), "{error}");
        }
        assert!(validate_source_build_backend("unknown").is_err());
    }

    #[test]
    fn unsupported_backends_never_reach_a_cmake_configure() {
        let source = Path::new("source");
        let build = Path::new("build");
        for backend in ["sycl", "openvino", "unknown"] {
            assert!(
                source_build_configure_args(backend, source, build, TEST_CUDA_ARCHITECTURES)
                    .is_err(),
                "{backend}"
            );
        }
        let vulkan =
            source_build_configure_args("vulkan", source, build, TEST_CUDA_ARCHITECTURES).unwrap();
        assert!(vulkan.iter().any(|arg| arg == "-DGGML_VULKAN=ON"));
        assert!(!vulkan.iter().any(|arg| arg.contains("GGML_HIP")
            || arg.contains("GGML_SYCL")
            || arg.contains("GGML_OPENVINO")));
        let rocm = source_build_configure_args("rocm", source, build, TEST_CUDA_ARCHITECTURES)
            .expect("ROCm is a supported local source backend");
        assert!(rocm.iter().any(|arg| arg == "-DGGML_HIP=ON"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_rocm_build_uses_the_upstream_clang_ninja_recipe() {
        let args = source_build_configure_args(
            "rocm",
            Path::new("source"),
            Path::new("build"),
            TEST_CUDA_ARCHITECTURES,
        )
        .expect("ROCm is a supported local source backend");
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-G" && pair[1] == "Ninja"));
        assert!(args.iter().any(|arg| arg == "-DCMAKE_C_COMPILER=clang"));
        assert!(args.iter().any(|arg| arg == "-DCMAKE_CXX_COMPILER=clang++"));
    }

    #[test]
    fn source_build_preflight_names_the_missing_sdk() {
        let absent = |_: &str| false;
        let present = |_: &str| true;
        let compiler_present = |name: &str| {
            if cfg!(windows) {
                name == "cl"
            } else {
                matches!(name, "cc" | "gcc" | "clang" | "c++" | "g++" | "clang++")
            }
        };
        let bare = ToolchainView {
            executable: &|name| compiler_present(name),
            directory_variable: &absent,
        };
        let cuda = missing_source_build_toolchain("cuda", &bare)
            .expect("cuda without a toolkit must be refused");
        assert!(cuda.contains("nvcc"), "{cuda}");
        assert!(cuda.contains("CUDACXX"), "{cuda}");
        let vulkan = missing_source_build_toolchain("vulkan", &bare)
            .expect("vulkan without an SDK must be refused");
        assert!(vulkan.contains("glslc"), "{vulkan}");
        assert!(vulkan.contains("VULKAN_SDK"), "{vulkan}");
        let rocm = missing_source_build_toolchain("rocm", &bare)
            .expect("ROCm without hipcc and an SDK must be refused");
        assert!(rocm.contains("hipcc"), "{rocm}");
        assert!(
            rocm.contains("HIP_PATH") && rocm.contains("ROCM_PATH"),
            "{rocm}"
        );
        assert!(missing_source_build_toolchain("cpu", &bare).is_none());

        let on_path = ToolchainView {
            executable: &present,
            directory_variable: &absent,
        };
        assert!(missing_source_build_toolchain("cuda", &on_path).is_none());
        assert!(missing_source_build_toolchain("vulkan", &on_path).is_none());

        let via_environment = ToolchainView {
            executable: &present,
            directory_variable: &present,
        };
        assert!(missing_source_build_toolchain("cuda", &via_environment).is_none());
        assert!(missing_source_build_toolchain("vulkan", &via_environment).is_none());

        let missing_compiler = ToolchainView {
            executable: &absent,
            directory_variable: &present,
        };
        let error = missing_source_build_toolchain("cpu", &missing_compiler)
            .expect("every backend needs a host compiler");
        assert!(error.contains("compiler"), "{error}");
    }

    /// Every name any allowlist can contribute, whether or not it is set on
    /// this machine. The environment functions only return names that are set,
    /// so testing what they *may* return needs the lists themselves.
    fn every_allowlisted_name() -> Vec<&'static str> {
        [
            BASE_ENVIRONMENT,
            PLATFORM_ENVIRONMENT,
            RUNTIME_DEVICE_ENVIRONMENT,
            BUILD_TOOLCHAIN_ENVIRONMENT,
            BUILD_TOOLING_ENVIRONMENT,
            BUILD_PLATFORM_ENVIRONMENT,
            BUILD_NETWORK_ENVIRONMENT,
        ]
        .concat()
    }

    #[test]
    fn no_allowlist_can_hand_a_child_a_credential() {
        for name in every_allowlisted_name() {
            assert!(
                !is_credential_name(name),
                "{name} would leak a credential to a child process"
            );
        }
        // The guard itself has to actually catch things, or the check above is
        // worth nothing.
        for name in [
            "GITHUB_TOKEN",
            "GH_TOKEN",
            "MY_API_KEY",
            "db_password",
            "SERVICE_SECRET",
            "SSH_AUTH_SOCK",
        ] {
            assert!(is_credential_name(name), "{name}");
        }
        assert!(!is_credential_name("PATH"));
        assert!(!is_credential_name("CUDA_PATH"));
    }

    #[test]
    fn a_child_environment_only_contains_names_that_are_set() {
        let names = |environment: Vec<(OsString, OsString)>| {
            environment
                .into_iter()
                .filter_map(|(name, _)| name.into_string().ok())
                .collect::<Vec<_>>()
        };
        let overrides = build_environment_overrides()
            .into_iter()
            .filter_map(|(name, _)| name.into_string().ok())
            .collect::<Vec<_>>();
        let allowed = every_allowlisted_name();
        for name in names(child_environment()) {
            assert!(
                allowed.contains(&name.as_str()),
                "{name} is not allowlisted"
            );
            assert!(std::env::var_os(&name).is_some(), "{name} is not set");
        }
        for name in names(build_environment()) {
            assert!(
                allowed.contains(&name.as_str()) || overrides.contains(&name),
                "{name} is neither allowlisted nor an override"
            );
        }
    }

    #[test]
    fn a_child_environment_never_repeats_a_name() {
        // Several categories legitimately name CUDA_PATH; handing a child the
        // same variable twice is at best confusing and at worst platform
        // dependent.
        for environment in [child_environment(), build_environment()] {
            let mut seen = std::collections::HashSet::new();
            for (name, _) in environment {
                assert!(seen.insert(name.clone()), "{name:?} appears twice");
            }
        }
    }

    #[test]
    fn staged_runtime_preflight_cannot_fall_back_to_the_build_host_sdk() {
        let staged = staged_runtime_environment_from(
            vec![
                (OsString::from("PATH"), OsString::from("host/bin")),
                (OsString::from("CUDA_PATH"), OsString::from("host/cuda")),
                (OsString::from("HIP_PATH"), OsString::from("host/rocm")),
                (
                    OsString::from("LD_LIBRARY_PATH"),
                    OsString::from("host/lib"),
                ),
                (OsString::from("CUDA_VISIBLE_DEVICES"), OsString::from("1")),
                (OsString::from("HOME"), OsString::from("user")),
            ],
            Path::new("staged/runtime"),
        );
        let value = |name: &str| {
            staged
                .iter()
                .find(|(key, _)| key.to_string_lossy() == name)
                .map(|(_, value)| value.to_string_lossy().into_owned())
        };

        assert_eq!(value("PATH").as_deref(), Some("staged/runtime"));
        assert_eq!(value("CUDA_PATH"), None);
        assert_eq!(value("HIP_PATH"), None);
        assert_eq!(value("CUDA_VISIBLE_DEVICES").as_deref(), Some("1"));
        assert_eq!(value("HOME").as_deref(), Some("user"));
        assert_eq!(
            staged
                .iter()
                .filter(|(key, _)| key.to_string_lossy() == "PATH")
                .count(),
            1
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            value("DYLD_LIBRARY_PATH").as_deref(),
            Some("staged/runtime")
        );
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(value("LD_LIBRARY_PATH").as_deref(), Some("staged/runtime"));
        #[cfg(not(unix))]
        assert_eq!(value("LD_LIBRARY_PATH"), None);
    }

    #[test]
    fn a_build_gets_what_cmake_and_its_generator_need_on_every_platform() {
        let allowed = every_allowlisted_name();
        // Compiler and generator selection.
        for name in ["CC", "CXX", "CMAKE_GENERATOR", "CMAKE_BUILD_PARALLEL_LEVEL"] {
            assert!(allowed.contains(&name), "{name}");
        }
        // SDK discovery for every backend a PR build supports.
        for name in ["CUDA_PATH", "CUDA_HOME", "VULKAN_SDK", "VK_SDK_PATH"] {
            assert!(allowed.contains(&name), "{name}");
        }
        // Keep the user's explicit GPU selection intact after the runtime
        // child environment is cleared.
        for name in [
            "CUDA_VISIBLE_DEVICES",
            "HIP_VISIBLE_DEVICES",
            "ROCR_VISIBLE_DEVICES",
            "ONEAPI_DEVICE_SELECTOR",
            "ZE_AFFINITY_MASK",
        ] {
            assert!(allowed.contains(&name), "{name}");
        }
        // Proxy, corporate CA trust, and Git - the three that decide whether a
        // build works on someone else's PC rather than only on a developer's.
        for name in [
            "HTTPS_PROXY",
            "https_proxy",
            "SSL_CERT_FILE",
            "GIT_EXEC_PATH",
        ] {
            assert!(allowed.contains(&name), "{name}");
        }
        // Enough OS to start a process at all, per platform.
        #[cfg(windows)]
        for name in [
            "SystemRoot",
            "COMSPEC",
            "PATHEXT",
            "ProgramFiles",
            "APPDATA",
        ] {
            assert!(allowed.contains(&name), "{name}");
        }
        #[cfg(target_os = "macos")]
        for name in ["DEVELOPER_DIR", "SDKROOT", "HOME"] {
            assert!(allowed.contains(&name), "{name}");
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        for name in ["LD_LIBRARY_PATH", "HOME", "XDG_CACHE_HOME"] {
            assert!(allowed.contains(&name), "{name}");
        }
    }

    #[test]
    fn a_build_child_can_never_stop_to_ask_for_a_password() {
        // A credential prompt behind a pipe nobody reads is an infinite build.
        let overrides = build_environment_overrides();
        let value = |wanted: &str| {
            overrides
                .iter()
                .find(|(name, _)| name == OsStr::new(wanted))
                .map(|(_, value)| value.clone())
        };
        assert_eq!(value("GIT_TERMINAL_PROMPT"), Some(OsString::from("0")));
        assert_eq!(value("GCM_INTERACTIVE"), Some(OsString::from("Never")));
        assert_eq!(value("CMAKE_TLS_VERIFY"), Some(OsString::from("1")));
        // The overrides must win over anything inherited.
        let environment = build_environment();
        let last = environment
            .iter()
            .rev()
            .find(|(name, _)| name == OsStr::new("GIT_TERMINAL_PROMPT"))
            .map(|(_, value)| value.clone());
        assert_eq!(last, Some(OsString::from("0")));
    }

    #[test]
    fn a_pr_configure_stays_inside_the_downloaded_archive() {
        let args = source_build_configure_args(
            "cpu",
            Path::new("source"),
            Path::new("build"),
            TEST_CUDA_ARCHITECTURES,
        )
        .expect("cpu configures");
        // BoringSSL is a FetchContent Git clone that also needs Go; curl and
        // OpenSSL power a download path llama-board never uses. All three are
        // network dependencies outside the pinned source archive.
        for option in SOURCE_BUILD_OFFLINE_OPTIONS {
            assert!(args.iter().any(|arg| arg == option), "{option}");
        }
        assert!(!args.iter().any(|arg| arg.ends_with("BORINGSSL=ON")));
        assert!(!args.iter().any(|arg| arg == "-DLLAMA_CURL=ON"));
    }

    #[test]
    fn build_failures_name_the_thing_the_user_has_to_fix() {
        let hint = |log: &str| build_failure_hint(log).unwrap_or_default();
        assert!(hint(
            "CMake Error at cmake/FetchContent.cmake:1 (message): Failed to clone repository"
        )
        .contains("Git"));
        assert!(
            hint("fatal: unable to access 'https://boringssl.googlesource.com/': Could not resolve proxy")
                .contains("proxy")
        );
        assert!(hint("No CMAKE_CXX_COMPILER could be found.").contains("compiler"));
        assert!(hint("fatal error C1083: No space left on device").contains("disk"));
        assert!(
            hint("nvcc fatal   : Unsupported gpu architecture 'compute_120'")
                .contains("CUDA Toolkit")
        );
        assert!(hint("glslc: error: cannot compile shader").contains("Vulkan"));
        // An unrecognised failure gets no invented advice.
        assert_eq!(build_failure_hint("undefined reference to `foo'"), None);
    }

    #[test]
    fn a_cleanup_plan_is_handed_off_instead_of_running_on_the_runtime() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-cleanup-async-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let workspace = root.join("workspace");
        let staging = root.join("staging");
        let archive = root.join("source.zip");
        fs::create_dir_all(workspace.join("build").join("deep")).expect("create build tree");
        fs::create_dir_all(&staging).expect("create staging");
        fs::write(&archive, b"partial").expect("create archive");
        fs::write(workspace.join("build").join("deep").join("a.obj"), b"o").expect("object");

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build a runtime");
        runtime.block_on(async {
            let mut cleanup = InstallCleanup::new(archive.clone(), staging.clone());
            cleanup.track_directory(workspace.clone());
            cleanup.finish().await;
        });

        assert!(!archive.exists());
        assert!(!workspace.exists());
        assert!(!staging.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_committed_install_keeps_its_runtime_and_still_clears_the_workspace() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-cleanup-commit-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let workspace = root.join("workspace");
        let staging = root.join("staging");
        let archive = root.join("source.zip");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::create_dir_all(&staging).expect("create staging");
        fs::write(&archive, b"partial").expect("create archive");

        let mut cleanup = InstallCleanup::new(archive.clone(), staging.clone());
        cleanup.track_directory(workspace.clone());
        cleanup.commit();
        let plan = cleanup.plan();
        plan.run();

        assert!(!archive.exists());
        assert!(!workspace.exists());
        // Committed: the staged runtime has already been moved into place by
        // `replace_runtime`, so cleanup must not touch it.
        assert!(staging.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_bounded_removal_gives_up_instead_of_retrying_for_ever() {
        let missing = std::env::temp_dir().join(format!(
            "llama-board-absent-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        // A directory that is already gone is a success, not an error to retry.
        assert!(remove_tree_bounded(&missing).is_ok());
        // A retry budget worth having, but not one that turns a genuinely
        // locked file into a thread that never finishes.
        const { assert!(CLEANUP_ATTEMPTS >= 2 && CLEANUP_ATTEMPTS <= 8) };
    }

    fn pull_request_json(
        number: u64,
        state: &str,
        merged: bool,
        head_repo: Option<&str>,
    ) -> PullRequestDetail {
        let repo = head_repo
            .map(|name| format!(r#"{{"full_name":"{name}"}}"#))
            .unwrap_or_else(|| "null".into());
        let merged_at = if merged {
            r#""2026-08-01T00:00:00Z""#
        } else {
            "null"
        };
        serde_json::from_str(&format!(
            r#"{{
                "number": {number},
                "title": "server: add a thing",
                "state": "{state}",
                "draft": true,
                "merged_at": {merged_at},
                "updated_at": "2026-08-20T10:00:00Z",
                "user": {{"login": "contributor"}},
                "head": {{
                    "sha": "0123456789ABCDEF0123456789abcdef01234567",
                    "ref": "feature-branch",
                    "repo": {repo}
                }}
            }}"#
        ))
        .expect("fixture should decode")
    }

    #[test]
    fn a_pull_request_resolves_to_the_provenance_the_user_is_shown() {
        let resolved = parse_pull_request_source(
            27342,
            pull_request_json(27342, "open", false, Some("contributor/llama.cpp")),
        )
        .expect("an open PR from a fork resolves");
        assert_eq!(resolved.source.author, "contributor");
        assert_eq!(resolved.source.head_ref, "feature-branch");
        assert_eq!(resolved.source.repository, "contributor/llama.cpp");
        assert!(resolved.source.fork);
        assert_eq!(resolved.source.state, "open");
        assert_eq!(resolved.title, "server: add a thing");
        assert!(resolved.draft);
        // The sha is normalised, because everything downstream compares it.
        assert_eq!(
            resolved.source.commit,
            "0123456789abcdef0123456789abcdef01234567"
        );

        let upstream = parse_pull_request_source(
            1,
            pull_request_json(1, "open", false, Some(LLAMA_REPOSITORY)),
        )
        .expect("an upstream branch resolves");
        assert!(!upstream.source.fork);
    }

    #[test]
    fn a_merged_pull_request_is_not_reported_as_merely_closed() {
        let merged = parse_pull_request_source(
            7,
            pull_request_json(7, "closed", true, Some(LLAMA_REPOSITORY)),
        )
        .expect("a merged PR resolves");
        assert_eq!(merged.source.state, "merged");
        let closed = parse_pull_request_source(
            8,
            pull_request_json(8, "closed", false, Some(LLAMA_REPOSITORY)),
        )
        .expect("a closed PR resolves");
        assert_eq!(closed.source.state, "closed");
    }

    #[test]
    fn a_pull_request_with_no_head_repository_cannot_be_built() {
        // The fork was deleted: there is no tree left to download, and no
        // amount of retrying changes that.
        let error = parse_pull_request_source(9, pull_request_json(9, "closed", false, None))
            .expect_err("a deleted fork must be refused");
        assert!(error.contains("no longer available"), "{error}");
        // A response for a different PR is never accepted as this one.
        assert!(parse_pull_request_source(
            10,
            pull_request_json(11, "open", false, Some(LLAMA_REPOSITORY))
        )
        .is_err());
    }

    #[test]
    fn a_force_pushed_head_invalidates_the_users_confirmation() {
        let resolved = parse_pull_request_source(
            27342,
            pull_request_json(27342, "open", false, Some("contributor/llama.cpp")),
        )
        .expect("resolves")
        .source;
        // The exact commit the dialog showed.
        assert!(confirm_pull_request_head(&resolved.commit, &resolved).is_ok());
        // Case and whitespace are cosmetic, not a different approval.
        assert!(confirm_pull_request_head(
            "  0123456789ABCDEF0123456789ABCDEF01234567 ",
            &resolved
        )
        .is_ok());

        // The branch moved after the dialog was shown: refuse, and say so.
        let stale =
            confirm_pull_request_head("ffffffffffffffffffffffffffffffffffffffff", &resolved)
                .expect_err("a moved head must be refused");
        assert!(stale.contains("moved after you confirmed it"), "{stale}");
        assert!(stale.contains(&resolved.commit), "{stale}");

        // No confirmation at all is not an implicit yes.
        for empty in ["", "   ", "not-a-sha", "0123456789abcdef"] {
            let error = confirm_pull_request_head(empty, &resolved)
                .expect_err("an unconfirmed build must be refused");
            assert!(error.contains("confirm"), "{error}");
        }
    }

    #[test]
    fn the_extracted_tree_has_to_carry_the_commit_that_was_requested() {
        let commit = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            archive_commit_check(Path::new(&format!("/tmp/llama.cpp-{commit}")), commit),
            ArchiveCommitCheck::Matches
        );
        // GitHub names the directory from the ref in the URL, so a different
        // sha there means a different tree than the one that was approved.
        let other = "ffffffffffffffffffffffffffffffffffffffff";
        assert_eq!(
            archive_commit_check(Path::new(&format!("/tmp/llama.cpp-{other}")), commit),
            ArchiveCommitCheck::Mismatch(other.to_string())
        );
        // A layout with no commit in it proves nothing either way, and must
        // not be reported as a pass.
        for name in ["llama.cpp", "llama.cpp-b10638", "llama.cpp-main"] {
            assert_eq!(
                archive_commit_check(Path::new("/tmp").join(name).as_path(), commit),
                ArchiveCommitCheck::Unknown,
                "{name}"
            );
        }
        assert_ne!(COMMIT_CHECK_MATCHED, COMMIT_CHECK_UNKNOWN);
    }

    #[test]
    fn a_source_manifest_round_trips_and_reads_older_installs() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-manifest-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).expect("create runtime dir");
        let source = RuntimeSource {
            pull_request: 27342,
            repository: "contributor/llama.cpp".into(),
            head_ref: "feature-branch".into(),
            author: "contributor".into(),
            state: "open".into(),
            fork: true,
            commit: "0123456789abcdef0123456789abcdef01234567".into(),
            archive_sha256: "a".repeat(64),
            commit_check: COMMIT_CHECK_MATCHED.into(),
            url: "https://github.com/ggml-org/llama.cpp/pull/27342".into(),
        };
        write_source_manifest(&root, &source).expect("write source manifest");
        assert_eq!(read_source_manifest(&root), Some(source));

        // A runtime installed before provenance was recorded still loads; the
        // new fields are simply empty rather than invented.
        fs::write(
            root.join(SOURCE_MANIFEST),
            r#"{"pull_request":1,"repository":"ggml-org/llama.cpp","commit":"0123456789abcdef0123456789abcdef01234567","archive_sha256":"","url":"https://example.invalid"}"#,
        )
        .expect("write a legacy manifest");
        let legacy = read_source_manifest(&root).expect("a legacy manifest still reads");
        assert_eq!(legacy.pull_request, 1);
        assert!(legacy.author.is_empty());
        assert!(legacy.commit_check.is_empty());
        assert!(!legacy.fork);
        let _ = fs::remove_dir_all(root);
    }

    // ---- L1: deterministic, newest-first toolchain discovery ----

    fn vs_install(year: u32, edition: &str) -> VisualStudioInstall {
        VisualStudioInstall {
            year,
            edition: edition.to_string(),
            cmake: PathBuf::from(format!("/vs/{year}/{edition}/cmake")),
            #[cfg(windows)]
            edition_root: PathBuf::from(format!("/vs/{year}/{edition}")),
        }
    }

    #[test]
    fn visual_studio_installs_are_ordered_newest_release_first() {
        // read_dir hands these back in filesystem order, which differs between
        // machines and after an update - so the same PC could silently switch
        // build tools. Sorting makes the choice a decision, not an accident.
        let mut installs = vec![
            vs_install(2019, "Community"),
            vs_install(2022, "BuildTools"),
            vs_install(2022, "Enterprise"),
            vs_install(2026, "Community"),
            vs_install(2022, "Professional"),
        ];
        sort_visual_studio_installs(&mut installs);
        let order: Vec<(u32, &str)> = installs
            .iter()
            .map(|install| (install.year, install.edition.as_str()))
            .collect();
        assert_eq!(
            order,
            vec![
                (2026, "Community"),
                (2022, "Enterprise"),
                (2022, "Professional"),
                (2022, "BuildTools"),
                (2019, "Community"),
            ]
        );
    }

    #[test]
    fn toolchain_ordering_does_not_depend_on_the_order_it_was_discovered_in() {
        let forward = vec![
            vs_install(2022, "Community"),
            vs_install(2022, "Enterprise"),
            vs_install(2026, "Preview"),
        ];
        let mut reversed = forward.clone();
        reversed.reverse();
        let mut first = forward;
        let mut second = reversed;
        sort_visual_studio_installs(&mut first);
        sort_visual_studio_installs(&mut second);
        assert_eq!(first, second);
        // An edition nobody listed still sorts, after the known ones.
        assert_eq!(first[0].year, 2026);
        assert_eq!(first[0].edition, "Preview");
    }

    #[cfg(windows)]
    #[test]
    fn a_standalone_cmake_is_preferred_over_the_one_visual_studio_bundles() {
        let candidates = windows_cmake_candidates();
        let standalone = candidates
            .iter()
            .position(|path| !path.to_string_lossy().contains("Microsoft Visual Studio"));
        let bundled = candidates
            .iter()
            .position(|path| path.to_string_lossy().contains("Microsoft Visual Studio"));
        if let (Some(standalone), Some(bundled)) = (standalone, bundled) {
            assert!(standalone < bundled, "{candidates:?}");
        }
        // Whatever this machine has, asking twice gives the same answer.
        assert_eq!(candidates, windows_cmake_candidates());
    }

    // ---- L2: toolchain version preflight ----

    #[test]
    fn cmake_version_banners_are_parsed() {
        assert_eq!(
            parse_cmake_version("cmake version 3.29.2\n\nCMake suite maintained..."),
            Some((3, 29, 2))
        );
        assert_eq!(
            parse_cmake_version("cmake version 3.31.0-rc1"),
            Some((3, 31, 0))
        );
        assert_eq!(parse_cmake_version("cmake version 4.0"), Some((4, 0, 0)));
        for text in ["", "not cmake", "cmake version", "cmake version x.y"] {
            assert_eq!(parse_cmake_version(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_cmake_older_than_the_command_lines_here_is_refused_with_a_way_out() {
        let path = Path::new("/tools/cmake");
        // 3.18 is the floor because CUDA PR builds use CMAKE_CUDA_ARCHITECTURES.
        let old = cmake_version_error(path, (3, 10, 2)).expect("an old CMake must be refused");
        assert!(old.contains("3.10.2"), "{old}");
        assert!(old.contains("3.18"), "{old}");
        assert!(
            old.contains("Kitware.CMake") || old.contains("cmake.org"),
            "{old}"
        );
        assert!(cmake_version_error(path, (3, 17, 9)).is_some());
        assert_eq!(cmake_version_error(path, (3, 18, 0)), None);
        assert_eq!(cmake_version_error(path, (4, 1, 0)), None);
    }

    // ---- L7: disk space ----

    #[test]
    fn a_disk_with_no_room_is_reported_before_anything_is_downloaded() {
        let path = Path::new("/data/downloads");
        let required = required_build_bytes("cuda");
        let error = free_space_error("PR source build", path, required, Some(2 * GIB))
            .expect("2 GB free must be refused for a CUDA build");
        assert!(error.contains("2.0 GB"), "{error}");
        assert!(error.contains("Free some space"), "{error}");
        // Enough room says nothing at all.
        assert_eq!(
            free_space_error("PR source build", path, required, Some(required)),
            None
        );
        // A platform that will not answer must never block the build.
        assert_eq!(
            free_space_error("PR source build", path, required, None),
            None
        );
        // CUDA compiles every architecture separately, so it needs more.
        assert!(required_build_bytes("cuda") > required_build_bytes("cpu"));
    }

    #[test]
    fn the_disk_message_names_the_step_once() {
        let error = free_space_error(
            "PR source build",
            Path::new("/data"),
            20 * GIB,
            Some(2 * GIB),
        )
        .expect("refused");
        // The regression: an inline {label} plus a positional argument printed
        // "for the PR source build: PR source build needs about ...".
        assert_eq!(error.matches("PR source build").count(), 1, "{error}");
        assert!(error.contains("it needs about 20.0 GB"), "{error}");
    }

    #[test]
    fn both_volumes_a_pr_build_writes_to_have_a_requirement() {
        // Downloads and runtimes are frequently on different drives, so the
        // installed runtime needs its own budget, not the build's.
        const { assert!(INSTALLED_RUNTIME_BYTES > 0) };
        assert!(INSTALLED_RUNTIME_BYTES < required_build_bytes("cpu"));
        let error = free_space_error(
            "installed runtime",
            Path::new("/runtimes"),
            INSTALLED_RUNTIME_BYTES,
            Some(0),
        )
        .expect("a full runtimes volume must be refused");
        assert!(error.contains("installed runtime"), "{error}");
    }

    #[test]
    fn workspace_nonces_stay_short_enough_for_a_windows_path_budget() {
        let nonce = short_nonce();
        // A llama.cpp build tree nests object files far below this directory,
        // and Windows still enforces MAX_PATH for many toolchains.
        assert_eq!(nonce.len(), 12);
        assert!(nonce.chars().all(|character| character.is_ascii_hexdigit()));
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(short_nonce()), "nonces must not repeat");
        }
    }

    #[test]
    fn a_missing_cmake_gives_advice_for_the_platform_it_is_running_on() {
        let error = cmake_not_found_error();
        assert!(error.contains("CMake was not found"), "{error}");
        #[cfg(windows)]
        {
            assert!(error.contains("Kitware.CMake"), "{error}");
            assert!(error.contains("Visual Studio"), "{error}");
        }
        #[cfg(target_os = "macos")]
        assert!(error.contains("brew install cmake"), "{error}");
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            assert!(error.contains("apt install cmake"), "{error}");
            // Telling a Linux user about Visual Studio is not advice.
            assert!(!error.contains("Visual Studio"), "{error}");
        }
    }

    #[test]
    fn free_space_is_measured_on_a_real_volume() {
        // The temp directory certainly exists; the point is that the platform
        // call returns something plausible rather than zero or an error.
        let available = available_bytes(&std::env::temp_dir());
        if let Some(available) = available {
            assert!(available > 0);
        }
        // A path whose leaf does not exist yet still resolves, via its parent.
        let missing = std::env::temp_dir().join(format!("llama-board-absent-{}", Uuid::new_v4()));
        assert_eq!(available_bytes(&missing).is_some(), available.is_some());
    }

    // ---- L3: pull request states ----

    #[test]
    fn every_pull_request_state_worth_a_second_look_is_reported() {
        let advisories = |state: &str, merged: bool, draft: bool, repo: &str| {
            let mut detail = pull_request_json(1, state, merged, Some(repo));
            detail.draft = draft;
            pull_request_advisories(&parse_pull_request_source(1, detail).expect("resolves"))
        };
        assert_eq!(
            advisories("open", false, false, LLAMA_REPOSITORY),
            Vec::<String>::new(),
            "an ordinary open upstream PR needs no warning"
        );
        assert!(advisories("open", false, true, LLAMA_REPOSITORY)
            .contains(&PR_ADVISORY_DRAFT.to_string()));
        assert!(advisories("closed", false, false, LLAMA_REPOSITORY)
            .contains(&PR_ADVISORY_CLOSED.to_string()));
        let merged = advisories("closed", true, false, LLAMA_REPOSITORY);
        assert!(merged.contains(&PR_ADVISORY_MERGED.to_string()));
        assert!(!merged.contains(&PR_ADVISORY_CLOSED.to_string()));
        assert!(advisories("open", false, false, "contributor/llama.cpp")
            .contains(&PR_ADVISORY_FORK.to_string()));
    }

    #[test]
    fn a_pull_request_whose_branch_was_deleted_is_flagged() {
        let mut detail = pull_request_json(1, "closed", false, Some(LLAMA_REPOSITORY));
        detail.head.reference = String::new();
        let advisories =
            pull_request_advisories(&parse_pull_request_source(1, detail).expect("resolves"));
        assert!(advisories.contains(&PR_ADVISORY_STALE_BRANCH.to_string()));
    }

    #[test]
    fn a_failed_lookup_says_what_to_do_about_it() {
        let status = reqwest::StatusCode::from_u16;
        let missing =
            pull_request_lookup_error(99999, status(404).unwrap(), r#"{"message":"Not Found"}"#);
        assert!(missing.contains("was not found"), "{missing}");
        assert!(missing.contains("issue number"), "{missing}");

        let limited = pull_request_lookup_error(
            1,
            status(403).unwrap(),
            r#"{"message":"API rate limit exceeded for 1.2.3.4"}"#,
        );
        assert!(limited.contains("rate-limiting"), "{limited}");

        let blocked =
            pull_request_lookup_error(1, status(403).unwrap(), r#"{"message":"Forbidden"}"#);
        assert!(blocked.contains("proxy"), "{blocked}");

        let broken =
            pull_request_lookup_error(1, status(503).unwrap(), r#"{"message":"unavailable"}"#);
        assert!(broken.contains("server error"), "{broken}");
    }

    // ---- L4: commit-aware runtime identity ----

    #[test]
    fn rebuilding_a_pull_request_reports_the_commit_it_displaced() {
        let source = |commit: &str| RuntimeSource {
            pull_request: 27342,
            repository: LLAMA_REPOSITORY.into(),
            commit: commit.into(),
            ..RuntimeSource::default()
        };
        let old = source(&"a".repeat(40));
        let new = source(&"b".repeat(40));

        let replaced = runtime_replacement(Some(&old), &new).expect("a new commit is news");
        assert_eq!(replaced.previous_commit, old.commit);
        assert_eq!(replaced.previous_pull_request, 27342);

        // Nothing there before, or the very same commit rebuilt: not news, and
        // reporting it would teach the user to ignore the message.
        assert_eq!(runtime_replacement(None, &new), None);
        assert_eq!(runtime_replacement(Some(&new), &new), None);
        // A pre-provenance runtime records no commit, so nothing can be said.
        assert_eq!(runtime_replacement(Some(&source("")), &new), None);
    }

    #[test]
    fn a_short_commit_is_what_git_would_abbreviate_to() {
        assert_eq!(
            short_commit("0123456789abcdef0123456789abcdef01234567"),
            "0123456"
        );
        assert_eq!(short_commit("abc"), "abc");
        assert_eq!(short_commit(""), "");
    }

    // ---- L5 / L6: what gets built ----

    #[test]
    fn a_pr_build_produces_the_server_and_the_bench_tool_and_nothing_else() {
        let args = source_build_args(Path::new("build"));
        for target in SOURCE_BUILD_TARGETS {
            assert!(args.iter().any(|arg| arg == target), "{target}");
        }
        assert!(args.iter().any(|arg| arg == "--target"));
        assert!(args.iter().any(|arg| arg == "Release"));
        assert!(args.iter().any(|arg| arg == "--parallel"));

        let configure = source_build_configure_args(
            "cpu",
            Path::new("source"),
            Path::new("build"),
            TEST_CUDA_ARCHITECTURES,
        )
        .expect("cpu configures");
        assert!(configure.iter().any(|arg| arg == "-DLLAMA_BUILD_SERVER=ON"));
        assert!(configure.iter().any(|arg| arg == "-DLLAMA_BUILD_TESTS=OFF"));
        assert!(configure
            .iter()
            .any(|arg| arg == "-DLLAMA_BUILD_EXAMPLES=OFF"));
        // The server web UI is disabled; nothing here may ask for a Node
        // toolchain or a fetched asset.
        assert!(configure.iter().any(|arg| arg == "-DLLAMA_BUILD_UI=OFF"));
        assert!(configure
            .iter()
            .any(|arg| arg == "-DLLAMA_USE_PREBUILT_UI=OFF"));
    }

    #[test]
    fn cuda_architectures_prefer_the_gpus_this_pc_actually_has() {
        // One RTX 4090: compile 89 once, not five generations, and keep PTX so
        // a newer card dropped in later still runs the same install.
        assert_eq!(
            cuda_architectures(None, &["8.9".to_string()]),
            "89-real;89-virtual"
        );
        // Two different cards: real code for both, PTX for the newer one.
        assert_eq!(
            cuda_architectures(None, &["8.6".to_string(), "7.5".to_string()]),
            "75-real;86-real;86-virtual"
        );
        // Duplicates are one architecture, not two compiles.
        assert_eq!(
            cuda_architectures(None, &["8.9".to_string(), "8.9".to_string()]),
            "89-real;89-virtual"
        );
    }

    #[test]
    fn cuda_architectures_fall_back_to_a_portable_list_when_nothing_is_detected() {
        assert_eq!(cuda_architectures(None, &[]), CUDA_ARCHITECTURES_PORTABLE);
        // Junk from nvidia-smi is not a detection.
        assert_eq!(
            cuda_architectures(None, &["".into(), "N/A".into()]),
            CUDA_ARCHITECTURES_PORTABLE
        );
        // The fallback keeps PTX, so it stays portable to newer hardware.
        assert!(CUDA_ARCHITECTURES_PORTABLE.contains("-virtual"));
    }

    #[test]
    fn a_user_supplied_cuda_architecture_list_wins_but_is_still_validated() {
        assert_eq!(
            cuda_architectures(Some("90-real"), &["8.9".to_string()]),
            "90-real"
        );
        assert_eq!(cuda_architectures(Some(" all "), &[]), "all");
        assert_eq!(
            cuda_architectures(Some("75-real;80-virtual"), &[]),
            "75-real;80-virtual"
        );
        // Anything that is not an architecture list is ignored rather than
        // pasted onto the configure command line.
        for hostile in [
            "89-real;-DCMAKE_CXX_FLAGS=-w",
            "89 && calc.exe",
            "$(whoami)",
            "",
            "   ",
        ] {
            assert_eq!(
                cuda_architectures(Some(hostile), &["8.9".to_string()]),
                "89-real;89-virtual",
                "{hostile:?} must not reach the configure"
            );
        }
    }

    #[test]
    fn only_a_cuda_build_pins_an_architecture_list() {
        let configure = |backend: &str| {
            source_build_configure_args(backend, Path::new("source"), Path::new("build"), "89-real")
                .expect("configures")
        };
        assert!(configure("cuda")
            .iter()
            .any(|arg| arg == "-DCMAKE_CUDA_ARCHITECTURES=89-real"));
        for backend in ["cpu", "vulkan"] {
            assert!(
                !configure(backend)
                    .iter()
                    .any(|arg| arg.contains("CUDA_ARCHITECTURES")),
                "{backend}"
            );
        }
    }

    // ---- previously identified test gaps ----

    #[test]
    fn command_line_paths_survive_spaces_and_are_passed_as_single_arguments() {
        let source = Path::new("C:/Users/a b/source");
        let build = Path::new("C:/Users/a b/build");
        let args =
            source_build_configure_args("cpu", source, build, TEST_CUDA_ARCHITECTURES).unwrap();
        // -S and -B carry the path as one argv entry; no quoting, no splitting.
        let position = args.iter().position(|arg| arg == "-S").expect("-S present");
        assert_eq!(args[position + 1], source.to_string_lossy());
        let position = args.iter().position(|arg| arg == "-B").expect("-B present");
        assert_eq!(args[position + 1], build.to_string_lossy());
        assert!(args.iter().all(|arg| !arg.contains('"')));
    }

    #[test]
    fn head_repositories_outside_a_plain_owner_slash_name_are_refused() {
        assert!(validate_source_repository("ggml-org/llama.cpp").is_ok());
        assert!(validate_source_repository("a_b-c.d/e_f-g.h").is_ok());
        for hostile in [
            "",
            "owner",
            "owner/",
            "/name",
            "owner/name/extra",
            "../etc",
            "owner/..",
            "../../owner/name",
            "owner/na me",
            "owner/na\\me",
            "owner/na:me",
            "own$er/name",
        ] {
            assert!(validate_source_repository(hostile).is_err(), "{hostile:?}");
        }
    }

    #[test]
    fn only_a_full_hexadecimal_commit_is_accepted() {
        assert!(validate_commit_sha(&"a".repeat(40)).is_ok());
        assert!(validate_commit_sha("0123456789abcdef0123456789abcdef01234567").is_ok());
        for hostile in [
            "",
            &"a".repeat(39),
            &"a".repeat(41),
            "0123456789abcdef0123456789abcdef0123456g",
            "0123456789abcdef0123456789abcdef0123 567",
            "../../../etc/passwd",
        ] {
            assert!(validate_commit_sha(hostile).is_err(), "{hostile:?}");
        }
    }

    #[test]
    fn a_pull_request_response_missing_optional_fields_still_resolves() {
        // GitHub omits fields for some PRs, and a deserialise error here would
        // read to the user as "invalid response" for a perfectly good PR.
        let detail: PullRequestDetail = serde_json::from_str(
            r#"{"number":5,"head":{"sha":"0123456789abcdef0123456789abcdef01234567","repo":{"full_name":"ggml-org/llama.cpp"}}}"#,
        )
        .expect("a minimal response should decode");
        let resolved = parse_pull_request_source(5, detail).expect("resolves");
        assert!(resolved.source.author.is_empty());
        assert!(resolved.source.head_ref.is_empty());
        assert_eq!(resolved.source.state, "unknown");
        assert!(resolved.title.is_empty());
    }

    #[test]
    fn a_pull_request_response_with_a_bad_commit_is_refused() {
        for sha in ["", "not-a-sha", "0123456789abcdef"] {
            let detail: PullRequestDetail = serde_json::from_str(&format!(
                r#"{{"number":5,"head":{{"sha":"{sha}","repo":{{"full_name":"ggml-org/llama.cpp"}}}}}}"#
            ))
            .expect("decodes");
            assert!(parse_pull_request_source(5, detail).is_err(), "{sha:?}");
        }
        // A head repository that is not a plain owner/name is refused too.
        let detail: PullRequestDetail = serde_json::from_str(
            r#"{"number":5,"head":{"sha":"0123456789abcdef0123456789abcdef01234567","repo":{"full_name":"../evil"}}}"#,
        )
        .expect("decodes");
        assert!(parse_pull_request_source(5, detail).is_err());
    }

    #[test]
    fn the_source_root_is_the_single_directory_that_holds_a_cmakelists() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-source-root-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let nested = root.join("llama.cpp-0123456");
        fs::create_dir_all(&nested).expect("create nested source");
        // Nothing to find yet.
        assert!(find_source_root(&root).is_err());

        fs::write(nested.join("CMakeLists.txt"), b"project(x)").expect("write CMakeLists");
        assert_eq!(find_source_root(&root).expect("one root"), nested);

        // A tree whose own top level is the source root is used directly.
        fs::write(root.join("CMakeLists.txt"), b"project(x)").expect("write CMakeLists");
        assert_eq!(find_source_root(&root).expect("top level"), root);

        // Two candidates is ambiguous, and guessing would build the wrong one.
        fs::remove_file(root.join("CMakeLists.txt")).expect("remove top level");
        let second = root.join("llama.cpp-89abcdef");
        fs::create_dir_all(&second).expect("create second");
        fs::write(second.join("CMakeLists.txt"), b"project(x)").expect("write CMakeLists");
        assert!(find_source_root(&root).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_built_runtime_directory_is_the_one_holding_both_binaries() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-built-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let release = root.join("bin").join("Release");
        fs::create_dir_all(&release).expect("create bin/Release");
        // Only the server: an incomplete build must not be accepted.
        fs::write(release.join(server_executable_name()), b"exe").expect("server");
        assert!(find_built_runtime_dir(&root).is_err());

        fs::write(release.join(bench_executable_name()), b"exe").expect("bench");
        assert_eq!(find_built_runtime_dir(&root).expect("found"), release);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_build_output_is_refused_rather_than_followed() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-symlink-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let source = root.join("out");
        let destination = root.join("staged");
        let secret = root.join("secret.txt");
        fs::create_dir_all(&source).expect("create out");
        fs::write(&secret, b"not yours").expect("write secret");
        std::os::unix::fs::symlink(&secret, source.join("link.txt")).expect("symlink");

        let cancel = Arc::new(AtomicBool::new(false));
        let error = copy_runtime_tree(&source, &destination, &cancel)
            .expect_err("a symlink must not be packaged");
        assert!(error.contains("symbolic link"), "{error}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_cancelled_copy_stops_instead_of_packaging_the_rest() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-copy-cancel-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let source = root.join("out");
        fs::create_dir_all(&source).expect("create out");
        for index in 0..4 {
            fs::write(source.join(format!("file{index}.bin")), b"data").expect("write");
        }
        let cancel = Arc::new(AtomicBool::new(true));
        let error = copy_runtime_tree(&source, &root.join("staged"), &cancel)
            .expect_err("a cancelled copy must not report success");
        assert!(error.contains("cancelled"), "{error}");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_cancelled_build_kills_the_child_and_reports_the_cancel() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/c", "ping -n 60 127.0.0.1 > nul"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 60"]);
            command
        };
        configure_build_process_group(&mut command);
        let child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn a long child");
        // Already cancelled: the supervisor must not wait out the sleep.
        let cancel = Arc::new(AtomicBool::new(true));
        let progress: ProgressSink = &|_, _, _| {};
        let started = Instant::now();
        let error = supervise_build_child(
            child,
            progress,
            "building",
            "test build",
            &cancel,
            Duration::from_secs(30),
        )
        .await
        .expect_err("a cancelled build must not report success");
        assert!(error.contains("cancelled"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    /// The deterministic timeout seam: a fake child that never exits on its
    /// own must still be killed and reported within a short, injected
    /// deadline, without waiting for its full runtime. The child also writes
    /// a fixed diagnostic to stderr before it would otherwise be killed, so
    /// this also proves the timeout error carries the phase, how long it
    /// ran, and the tail of whatever diagnostic the child managed to emit —
    /// not just the fact that a timeout occurred.
    #[tokio::test]
    async fn a_build_that_outlives_its_deadline_is_killed_and_reported() {
        const DIAGNOSTIC_MARKER: &str = "TIMEOUT_DIAGNOSTIC_MARKER_9F3A";
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args([
                "/c",
                &format!("echo {DIAGNOSTIC_MARKER} 1>&2 && ping -n 60 127.0.0.1 > nul"),
            ]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", &format!("echo {DIAGNOSTIC_MARKER} 1>&2; sleep 60")]);
            command
        };
        configure_build_process_group(&mut command);
        let child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn a long child");
        let cancel = Arc::new(AtomicBool::new(false));
        let progress: ProgressSink = &|_, _, _| {};
        let deadline = Duration::from_millis(200);
        let started = Instant::now();
        let error =
            supervise_build_child(child, progress, "building", "test build", &cancel, deadline)
                .await
                .expect_err("a build past its deadline must not report success");
        assert!(error.contains("timeout"), "{error}");
        assert!(error.contains("test build"), "{error}");
        assert!(
            error.contains(DIAGNOSTIC_MARKER),
            "error must include the child's last diagnostic output: {error}"
        );
        // The deadline must be enforced, not merely observed after the fact:
        // this must return in well under the child's 60-second sleep.
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "deadline enforcement took {:?}",
            started.elapsed()
        );
    }

    /// A spawned grandchild that keeps appending to a marker file until its
    /// process group is killed, shared by the cancellation and timeout
    /// process-group tests below so each only has to state what makes it
    /// distinct: which stop path it exercises.
    #[cfg(unix)]
    struct MarkerGrandchild {
        root: PathBuf,
        marker: PathBuf,
        pid_file: PathBuf,
        child: tokio::process::Child,
    }

    #[cfg(unix)]
    async fn spawn_marker_grandchild() -> MarkerGrandchild {
        let root = std::env::temp_dir().join(format!(
            "llama-board-process-group-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).expect("create process-group test root");
        let marker = root.join("grandchild-alive");
        let pid_file = root.join("grandchild.pid");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "(while :; do printf x >> \"$LLAMA_BOARD_MARKER\"; sleep 0.02; done) & child=$!; echo \"$child\" > \"$LLAMA_BOARD_PID\"; wait",
        ])
        .env("LLAMA_BOARD_MARKER", &marker)
        .env("LLAMA_BOARD_PID", &pid_file);
        configure_build_process_group(&mut command);
        let child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn process-group test child");

        for _ in 0..100 {
            if marker.is_file() && pid_file.is_file() {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
        assert!(marker.is_file(), "grandchild did not start");
        MarkerGrandchild {
            root,
            marker,
            pid_file,
            child,
        }
    }

    /// Asserts the marker file stopped growing (the grandchild is dead) and
    /// cleans up, killing the recorded PID directly as a last resort so a
    /// failed assertion never leaves a background process running. Takes the
    /// marker/pid_file/root by value rather than the whole `MarkerGrandchild`
    /// because callers have already moved `child` into `supervise_build_child`
    /// by this point.
    #[cfg(unix)]
    async fn assert_grandchild_stopped_and_cleanup(
        marker: PathBuf,
        pid_file: PathBuf,
        root: PathBuf,
        context: &str,
    ) {
        let grandchild_pid = fs::read_to_string(&pid_file)
            .expect("read grandchild pid")
            .trim()
            .parse::<libc::pid_t>()
            .expect("parse grandchild pid");

        let size_after_stop = fs::metadata(&marker).map(|metadata| metadata.len());
        sleep(Duration::from_millis(120)).await;
        let size_after_wait = fs::metadata(&marker).map(|metadata| metadata.len());
        assert_eq!(
            size_after_stop, size_after_wait,
            "grandchild kept writing after {context}"
        );

        // If the assertion above fails, leave no process behind to affect later
        // tests. On the normal path this is harmless because the group kill has
        // already made the PID invalid.
        unsafe {
            let _ = libc::kill(grandchild_pid, libc::SIGKILL);
        }
        let _ = fs::remove_dir_all(root);
    }

    /// CMake generators routinely leave a compiler wrapper or shell grandchild
    /// behind. This must stay Unix-only: Windows has a separate taskkill-tree
    /// implementation and this test relies on POSIX process-group semantics.
    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_a_build_kills_a_grandchild_in_the_process_group() {
        let grandchild = spawn_marker_grandchild().await;
        let cancel = Arc::new(AtomicBool::new(true));
        let progress: ProgressSink = &|_, _, _| {};
        let error = supervise_build_child(
            grandchild.child,
            progress,
            "building",
            "test build",
            &cancel,
            Duration::from_secs(30),
        )
        .await
        .expect_err("a cancelled build must not report success");
        assert!(error.contains("cancelled"), "{error}");

        assert_grandchild_stopped_and_cleanup(
            grandchild.marker,
            grandchild.pid_file,
            grandchild.root,
            "cancellation",
        )
        .await;
    }

    /// The timeout path must kill the whole process group exactly like
    /// cancellation does, not just the direct child: this is the deadline
    /// counterpart to `cancelling_a_build_kills_a_grandchild_in_the_process_group`
    /// above, sharing its marker-grandchild setup so the two tests differ
    /// only in which stop path they drive.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_build_timeout_kills_a_grandchild_in_the_process_group() {
        let grandchild = spawn_marker_grandchild().await;
        let cancel = Arc::new(AtomicBool::new(false));
        let progress: ProgressSink = &|_, _, _| {};
        let error = supervise_build_child(
            grandchild.child,
            progress,
            "building",
            "test build",
            &cancel,
            Duration::from_millis(200),
        )
        .await
        .expect_err("a build past its deadline must not report success");
        assert!(error.contains("timeout"), "{error}");

        assert_grandchild_stopped_and_cleanup(
            grandchild.marker,
            grandchild.pid_file,
            grandchild.root,
            "the deadline killed the tree",
        )
        .await;
    }

    #[test]
    fn every_supported_backend_maps_to_exactly_one_ggml_option() {
        let option_for = |backend: &str| {
            source_build_configure_args(
                backend,
                Path::new("source"),
                Path::new("build"),
                TEST_CUDA_ARCHITECTURES,
            )
            .expect("configures")
            .into_iter()
            .filter(|arg| arg.starts_with("-DGGML_") && arg.ends_with("=ON"))
            .collect::<Vec<_>>()
        };
        // GGML_BACKEND_DL and GGML_CPU_ALL_VARIANTS are on for every build; the
        // backend-selecting option is the one that must differ.
        assert!(option_for("cuda").contains(&"-DGGML_CUDA=ON".to_string()));
        assert!(option_for("vulkan").contains(&"-DGGML_VULKAN=ON".to_string()));
        assert!(option_for("rocm").contains(&"-DGGML_HIP=ON".to_string()));
        assert!(option_for("cpu").contains(&"-DGGML_CPU=ON".to_string()));
        assert!(!option_for("cuda").contains(&"-DGGML_VULKAN=ON".to_string()));
        assert!(!option_for("vulkan").contains(&"-DGGML_CUDA=ON".to_string()));
        assert!(!option_for("rocm").contains(&"-DGGML_CUDA=ON".to_string()));
        assert!(!option_for("cpu").contains(&"-DGGML_CUDA=ON".to_string()));
    }

    #[test]
    fn vendor_builds_request_a_runtime_path_relative_to_the_installed_binary() {
        for backend in ["cuda", "rocm"] {
            let args = source_build_configure_args(
                backend,
                Path::new("source"),
                Path::new("build"),
                TEST_CUDA_ARCHITECTURES,
            )
            .expect("configures");
            match portable_runtime_rpath() {
                Some(rpath) => {
                    assert!(
                        args.iter()
                            .any(|arg| arg == &format!("-DCMAKE_BUILD_RPATH={rpath}")),
                        "{backend}"
                    );
                    assert!(args
                        .iter()
                        .any(|arg| arg == "-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON"));
                    assert!(
                        args.iter()
                            .any(|arg| arg == &format!("-DCMAKE_INSTALL_RPATH={rpath}")),
                        "{backend}"
                    );
                }
                None => assert!(!args.iter().any(|arg| arg.contains("CMAKE_BUILD_RPATH"))),
            }
        }
    }

    #[test]
    fn every_configure_keeps_the_result_portable_across_cpus() {
        for backend in SOURCE_BUILD_BACKENDS {
            let args = source_build_configure_args(
                backend,
                Path::new("source"),
                Path::new("build"),
                TEST_CUDA_ARCHITECTURES,
            )
            .expect("configures");
            // GGML_NATIVE would bake this machine's instruction set into the
            // binary; the runtime has to keep working after a CPU change.
            assert!(
                args.iter().any(|arg| arg == "-DGGML_NATIVE=OFF"),
                "{backend}"
            );
            assert!(
                args.iter().any(|arg| arg == "-DGGML_CPU_ALL_VARIANTS=ON"),
                "{backend}"
            );
            assert!(
                args.iter().any(|arg| arg == "-DGGML_BACKEND_DL=ON"),
                "{backend}"
            );
        }
    }

    #[test]
    fn a_listed_runtime_carries_its_recorded_provenance() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-listing-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        let dir = root.join("pr27342-cuda");
        fs::create_dir_all(&dir).expect("create runtime dir");
        let source = RuntimeSource {
            pull_request: 27342,
            repository: "contributor/llama.cpp".into(),
            head_ref: "feature".into(),
            author: "contributor".into(),
            state: "open".into(),
            fork: true,
            commit: "0123456789abcdef0123456789abcdef01234567".into(),
            archive_sha256: "b".repeat(64),
            commit_check: COMMIT_CHECK_MATCHED.into(),
            url: "https://github.com/ggml-org/llama.cpp/pull/27342".into(),
        };
        write_source_manifest(&dir, &source).expect("write source manifest");
        let version = RuntimeVersion {
            semver: "0.3.0-dev".into(),
            build: 10638,
            commit: "bf9421646".into(),
        };
        write_version_manifest(&dir, &version);

        let read_back = read_source_manifest(&dir).expect("manifest round-trips");
        assert_eq!(read_back, source);
        assert_eq!(read_version_manifest(&dir), Some(version));
        // A runtime that was never a PR build simply has no source manifest.
        let release = root.join("b10638-cuda");
        fs::create_dir_all(&release).expect("create release dir");
        assert_eq!(read_source_manifest(&release), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_manifest_that_is_not_valid_json_is_ignored_rather_than_fatal() {
        let root = std::env::temp_dir().join(format!(
            "llama-board-bad-manifest-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).expect("create dir");
        fs::write(root.join(SOURCE_MANIFEST), b"{ this is not json").expect("write");
        fs::write(root.join(VERSION_MANIFEST), b"").expect("write");
        assert_eq!(read_source_manifest(&root), None);
        assert_eq!(read_version_manifest(&root), None);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn probe_output_is_capped_from_the_front() {
        // Version banners and --help are read from the start, so the cap keeps
        // the head - the opposite of a build log.
        let payload = vec![b'x'; MAX_PROBE_OUTPUT + 4096];
        let output = read_probe_output(payload.as_slice()).await;
        assert_eq!(output.len(), MAX_PROBE_OUTPUT);
        assert!(output.iter().all(|byte| *byte == b'x'));
    }

    #[test]
    fn a_build_log_tail_is_capped_in_characters_not_bytes() {
        // A tail cut at a byte boundary would split a multi-byte character and
        // produce mojibake in the one message the user has to read.
        let log = "λ".repeat(MAX_BUILD_DETAIL_CHARS * 2);
        let detail = build_failure_detail(log.as_bytes(), b"");
        assert!(detail.chars().count() <= MAX_BUILD_DETAIL_CHARS);
        assert!(detail.chars().all(|character| character == 'λ'));
    }

    /// This is intentionally opt-in and ignored: it copies the locally
    /// installed multi-GB ROCm PR runtime into an isolated APPDATA tree, then
    /// exercises the same export/import path a second PC uses.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn live_pr27342_rocm_bundle_round_trips_without_host_sdk() {
        if std::env::var("LLAMA_BOARD_LIVE_BUNDLE_TEST")
            .ok()
            .as_deref()
            != Some("1")
        {
            return;
        }
        let Some(original_appdata) = std::env::var_os("APPDATA") else {
            return;
        };
        let installed = PathBuf::from(&original_appdata)
            .join("llama-board")
            .join("runtimes")
            .join("pr27342-rocm");
        if !installed.is_dir() {
            return;
        }
        let isolated_appdata = test_directory("live-bundle-appdata");
        let isolated_runtime = isolated_appdata
            .join("llama-board")
            .join("runtimes")
            .join("pr27342-rocm");
        fs::create_dir_all(isolated_runtime.parent().expect("runtime parent"))
            .expect("create isolated runtime parent");
        let cancel = Arc::new(AtomicBool::new(false));
        copy_runtime_tree(&installed, &isolated_runtime, &cancel).expect("copy live runtime");
        std::env::set_var("APPDATA", &isolated_appdata);
        let progress: ProgressSink = &|_, _, _| {};
        let archive = isolated_appdata.join("pr27342-rocm-portable.zip");
        let _result = async {
            let exported = export_bundle(&archive, "rocm", "pr27342", progress, &cancel)
                .expect("export live ROCm runtime");
            assert!(Path::new(&exported.path).is_file());
            assert!(Path::new(&(exported.path.clone() + ".sha256")).is_file());
            let imported = import_bundle(&archive, progress, cancel.clone())
                .await
                .expect("import live ROCm runtime");
            assert_eq!(imported.backend, "rocm");
            assert_eq!(imported.build, "pr27342");
            assert!(isolated_runtime.join("rocblas/library").is_dir());
            assert!(isolated_runtime.join("hipblaslt/library").is_dir());
            assert!(isolated_runtime.join("vcomp140.dll").is_file());
        }
        .await;
        std::env::set_var("APPDATA", original_appdata);
        let _ = fs::remove_dir_all(isolated_appdata);
    }
}
