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
