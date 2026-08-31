import type * as api from "../api";
import type { Locale } from "../i18nCatalog";
import type { UiTextKey } from "../uiI18n";
import { translate } from "../i18nUnified";

export const LATEST_CACHE_KEY = "llama-board.latest-runtimes.v2";
export const SHOW_ALL_KEY = "llama-board.show-all-backends.v1";

export function readShowAll(): boolean {
  try { return localStorage.getItem(SHOW_ALL_KEY) === "1"; } catch { return false; }
}

export function writeShowAll(value: boolean) {
  try { localStorage.setItem(SHOW_ALL_KEY, value ? "1" : "0"); } catch { /* storage is optional */ }
}

export const FIT_ORDER: Record<api.BackendFit, number> = { recommended: 0, compatible: 1, unsupported: 2 };
type LatestCache = { savedAt: number; infos: Record<string, api.LatestInfo>; errors?: Record<string, string> };

export function readLatestCache(): LatestCache | null {
  try {
    const raw = localStorage.getItem(LATEST_CACHE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as LatestCache;
    return Date.now() - value.savedAt < 10 * 60 * 1000 ? value : null;
  } catch {
    return null;
  }
}

export function writeLatestCache(infos: Record<string, api.LatestInfo>, errors: Record<string, string>) {
  try {
    localStorage.setItem(LATEST_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), infos, errors } satisfies LatestCache));
  } catch {
    // A restricted WebView may not provide localStorage.
  }
}

export const BACKENDS = [
  { id: "rocm", label: "backendRocm", note: "noteAmd" },
  { id: "vulkan", label: "backendVulkan", note: "noteVulkan" },
  { id: "cuda", label: "backendCuda", note: "noteNvidia" },
  { id: "sycl", label: "backendSycl", note: "noteIntel" },
  { id: "openvino", label: "backendOpenvino", note: "noteIntel" },
  { id: "cpu", label: "backendCpu", note: "noteCpu" },
] as const satisfies readonly { id: string; label: UiTextKey; note: UiTextKey }[];

export interface BackendRow {
  backend: string;
  label: UiTextKey;
  note: UiTextKey;
  latest: api.LatestInfo | null;
  latestErr: string | null;
  installed: api.InstalledRuntime[];
  busy: boolean;
  progress: api.DownloadProgress | null;
}

export const initialRows = (): BackendRow[] => BACKENDS.map((backend) => ({
  backend: backend.id,
  label: backend.label,
  note: backend.note,
  latest: null,
  latestErr: null,
  installed: [],
  busy: false,
  progress: null,
}));

export function mergeBackendRows(previous: BackendRow[], installed: api.InstalledRuntime[]): BackendRow[] {
  const ids = [...new Set([...previous.map((row) => row.backend), ...installed.map((item) => item.backend)])];
  return ids.map((id) => previous.find((row) => row.backend === id) ?? {
    backend: id,
    label: "unknownBackend",
    note: "unknownBackendNote",
    latest: null,
    latestErr: null,
    installed: [],
    busy: false,
    progress: null,
  });
}

/**
 * Provenance for an already-installed PR runtime, recorded at build time.
 *
 * `commit_check` is spelled out rather than assumed: a runtime whose archive
 * layout could not confirm the commit says so, instead of looking identical to
 * one that was confirmed.
 */
export function prSourceTitle(locale: Locale, source: api.RuntimeSource): string {
  const parts = [
    `${translate(locale, "ui.runtimePrBuild", { pr: source.pull_request })} · ${translate(locale, "ui.prSourceLabelRepository")}: ${source.repository}`,
    `${translate(locale, "ui.prFieldCommit")}: ${source.commit}`,
  ];
  if (source.head_ref) parts.push(`${translate(locale, "ui.prFieldHeadRef")}: ${source.head_ref}`);
  if (source.author) parts.push(`${translate(locale, "ui.prFieldAuthor")}: ${source.author}`);
  if (source.state) parts.push(`${translate(locale, "ui.prFieldState")}: ${source.state}`);
  if (source.commit_check && !["archive-directory-matches-commit", "github-actions-checkout-ref"].includes(source.commit_check)) {
    parts.push(translate(locale, "ui.prSourceUnverified"));
  }
  return parts.join("\n");
}
