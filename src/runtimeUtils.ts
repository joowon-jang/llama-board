export type CapabilityState = "available" | "failed preflight" | "not installed" | "unsupported by this runtime build" | "unknown";

export interface LoadingProfile {
  id: string;
  name: string;
  backend: string;
  build: string;
  active_model: string;
  mmproj: string;
  ctx_size: number;
  ngl: number;
  threads: number;
  flash_attn: string;
}

export interface RuntimeVersion {
  semver: string;
  build: number;
  commit: string;
}

/** `b10638` -> `10638`; anything else is returned unchanged. */
export function buildNumber(build: string): string {
  return /^b\d+$/.test(build) ? build.slice(1) : build;
}

/**
 * llama.cpp tags every CI build as `bNNNN` and only the binary itself knows the
 * semantic version, so show the version when it has been recorded and fall back
 * to a spelled-out build number otherwise.
 *
 * `0.3.0-dev · build 10638` / `build 10638`
 */
export function formatRuntimeVersion(build: string, version?: RuntimeVersion | null): string {
  const label = `build ${buildNumber(build)}`;
  return version?.semver ? `${version.semver} · ${label}` : label;
}

export function extractFlagNames(help: string): string[] {
  const seen = new Set<string>();
  const flags: string[] = [];
  for (const match of help.matchAll(/--[A-Za-z0-9][A-Za-z0-9-]*/g)) {
    const flag = match[0];
    if (!seen.has(flag)) { seen.add(flag); flags.push(flag); }
  }
  return flags;
}

export function parseDeviceLines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && line.length <= 256).slice(0, 100);
}

export function capabilityLabel(state: CapabilityState): string {
  switch (state) {
    case "available": return "Available";
    case "failed preflight": return "Preflight failed";
    case "not installed": return "Not installed";
    case "unsupported by this runtime build": return "Unsupported by build";
    default: return "Unknown";
  }
}

function profileString(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optionalProfileString(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length <= max;
}

function validLoadingProfile(value: unknown): value is LoadingProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<LoadingProfile>;
  return profileString(profile.id, 128)
    && profileString(profile.name, 256)
    && profileString(profile.backend, 64)
    && profileString(profile.build, 128)
    && optionalProfileString(profile.active_model)
    && optionalProfileString(profile.mmproj)
    && typeof profile.ctx_size === "number"
    && Number.isInteger(profile.ctx_size)
    && profile.ctx_size >= 256
    && profile.ctx_size <= 1_048_576
    && typeof profile.ngl === "number"
    && Number.isInteger(profile.ngl)
    && profile.ngl >= -1
    && profile.ngl <= 1_000_000
    && typeof profile.threads === "number"
    && Number.isInteger(profile.threads)
    && profile.threads >= 0
    && profile.threads <= 4096
    && profileString(profile.flash_attn, 32);
}

function localStorageSafe(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLoadingProfiles(key = "llama-board.loading-profiles.v1"): LoadingProfile[] {
  try {
    const storage = localStorageSafe();
    if (!storage) return [];
    const parsed = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(validLoadingProfile) : [];
  } catch {
    return [];
  }
}

export function writeLoadingProfiles(profiles: LoadingProfile[], key = "llama-board.loading-profiles.v1"): void {
  try {
    const storage = localStorageSafe();
    if (storage) storage.setItem(key, JSON.stringify(profiles.filter(validLoadingProfile).slice(0, 20)));
  } catch { /* restricted WebView */ }
}

/**
 * Backends a local pull-request build can honestly produce. Mirrors
 * `SOURCE_BUILD_BACKENDS` in `src-tauri/src/runtime.rs`, which refuses the
 * rest before anything is downloaded. ROCm is included when its local HIP
 * toolchain is present; the resulting build is explicitly machine-local in
 * the confirmation flow because the GPU driver remains host supplied.
 */
export const PR_BUILD_BACKENDS = ["cpu", "vulkan", "cuda", "rocm"] as const;

export function canBuildPrBackend(backend: string): boolean {
  return (PR_BUILD_BACKENDS as readonly string[]).includes(backend);
}

/** First backend the PR builder accepts, used when the current pick is not buildable. */
export function defaultPrBackend(preferred: string): string {
  return canBuildPrBackend(preferred) ? preferred : PR_BUILD_BACKENDS[0];
}

/**
 * Pick a source-build backend from the device policy, keeping CPU as the safe
 * answer when detection is unavailable or only reports unsupported hardware.
 * The report's ordering is backend policy, not the live picker value.
 */
export function defaultPrBackendForDevice(
  report: { backends: Array<{ backend: string; fit: string }> } | null | undefined,
): string {
  const recommended = report?.backends.find(
    (backend) => backend.fit === "recommended" && canBuildPrBackend(backend.backend),
  );
  return recommended?.backend ?? "cpu";
}

const BUILD_PHASE_LABELS = {
  resolving: "buildPhaseResolving",
  downloading: "buildPhaseDownloading",
  "downloading source": "buildPhaseDownloadingSource",
  verified: "buildPhaseVerified",
  "recorded source digest": "buildPhaseRecordedSourceDigest",
  extracting: "buildPhaseExtracting",
  "extracting source": "buildPhaseExtractingSource",
  configuring: "buildPhaseConfiguring",
  building: "buildPhaseBuilding",
  packaging: "buildPhasePackaging",
  preflight: "buildPhasePreflight",
  installed: "buildPhaseInstalled",
  "cleaning up": "buildPhaseCleaningUp",
} as const;

export type BuildPhaseLabelKey = typeof BUILD_PHASE_LABELS[keyof typeof BUILD_PHASE_LABELS];

/** Return a translated label for every stable backend progress phase. */
export function buildPhaseLabelKey(phase: string): BuildPhaseLabelKey | "buildPhaseWorking" {
  return BUILD_PHASE_LABELS[phase as keyof typeof BUILD_PHASE_LABELS] ?? "buildPhaseWorking";
}

/**
 * The exact message the backend returns when an install stops because the user
 * asked it to. See `install_pr_with` / `install_with` in `runtime.rs`.
 */
const INSTALL_CANCELLED = "runtime install cancelled";

/**
 * Did this install stop because the user cancelled it, or because it failed?
 *
 * Matching any message containing "cancel" also swallows a real build failure
 * whose CMake log tail happens to mention a cancelled operation — and a
 * swallowed failure shows as a four-second flash instead of an error the user
 * can read and act on. Match the backend's own sentinel instead.
 */
export function isInstallCancellation(message: string): boolean {
  return message.toLowerCase().includes(INSTALL_CANCELLED);
}

export type RuntimeRowAction = "cancel" | "install" | "none";

/**
 * Which action the header button of a backend row offers.
 *
 * A busy row always offers cancel, including when the newest release build is
 * already installed: a PR build marks that row busy too, and hiding the button
 * there left a long local build with no way to stop it.
 */
export function runtimeRowAction(row: { busy: boolean; newestInstalled: boolean }): RuntimeRowAction {
  if (row.busy) return "cancel";
  return row.newestInstalled ? "none" : "install";
}
