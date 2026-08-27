export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "llama-board-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function getStoredThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const preferences = JSON.parse(window.localStorage.getItem("llama-board-preferences") ?? "null") as { values?: { theme?: unknown } } | null;
    const theme = preferences?.values?.theme;
    if (isThemeMode(typeof theme === "string" ? theme : null)) return theme as ThemeMode;
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") return mode;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
  return resolved;
}

export function persistThemeMode(mode: ThemeMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Theme still applies for this session when storage is unavailable.
  }
}

export function subscribeToSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(DARK_QUERY);
  const listener = () => onChange();
  media.addEventListener?.("change", listener);
  return () => media.removeEventListener?.("change", listener);
}

export { STORAGE_KEY };

applyTheme(getStoredThemeMode());
