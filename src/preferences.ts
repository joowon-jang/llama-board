import type { ThemeMode } from "./theme";
import { detectLocale, type Locale } from "./i18nCatalog";

export interface AppPreferences {
  locale: Locale;
  theme: ThemeMode;
  chat: { enterToSend: boolean; showTimestamps: boolean; streamResponses: boolean; compactMessages: boolean };
  server: { autoStart: boolean; autoStopOnExit: boolean; pollIntervalMs: number };
  appearance: { reduceMotion: boolean; density: "comfortable" | "compact" };
  advanced: { developerMode: boolean; confirmDestructiveActions: boolean };
}

interface StoredPreferences { version: 1; values: AppPreferences }
const KEY = "llama-board-preferences";

export const defaultPreferences = (): AppPreferences => ({
  locale: detectLocale(), theme: "system",
  chat: { enterToSend: true, showTimestamps: true, streamResponses: true, compactMessages: false },
  server: { autoStart: false, autoStopOnExit: false, pollIntervalMs: 1000 },
  appearance: { reduceMotion: false, density: "comfortable" },
  advanced: { developerMode: false, confirmDestructiveActions: true },
});

const isLocale = (v: unknown): v is Locale => v === "ko" || v === "en" || v === "ja" || v === "zh";
const isTheme = (v: unknown): v is ThemeMode => v === "light" || v === "dark" || v === "system";

export function validatePreferences(input: Partial<AppPreferences> | null | undefined): AppPreferences {
  const d = defaultPreferences();
  const p = input ?? {};
  return {
    locale: isLocale(p.locale) ? p.locale : d.locale,
    theme: isTheme(p.theme) ? p.theme : d.theme,
    chat: { ...d.chat, ...(p.chat ?? {}), enterToSend: Boolean(p.chat?.enterToSend ?? d.chat.enterToSend), showTimestamps: Boolean(p.chat?.showTimestamps ?? d.chat.showTimestamps), streamResponses: Boolean(p.chat?.streamResponses ?? d.chat.streamResponses), compactMessages: Boolean(p.chat?.compactMessages ?? d.chat.compactMessages) },
    server: { ...d.server, ...(p.server ?? {}), autoStart: Boolean(p.server?.autoStart ?? d.server.autoStart), autoStopOnExit: Boolean(p.server?.autoStopOnExit ?? d.server.autoStopOnExit), pollIntervalMs: [500, 1000, 2000, 5000].includes(Number(p.server?.pollIntervalMs)) ? Number(p.server?.pollIntervalMs) : d.server.pollIntervalMs },
    appearance: { ...d.appearance, ...(p.appearance ?? {}), reduceMotion: Boolean(p.appearance?.reduceMotion ?? d.appearance.reduceMotion), density: p.appearance?.density === "compact" ? "compact" : "comfortable" },
    advanced: { ...d.advanced, ...(p.advanced ?? {}), developerMode: Boolean(p.advanced?.developerMode ?? d.advanced.developerMode), confirmDestructiveActions: Boolean(p.advanced?.confirmDestructiveActions ?? d.advanced.confirmDestructiveActions) },
  };
}

export function loadPreferences(): AppPreferences {
  if (typeof window === "undefined") return defaultPreferences();
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as StoredPreferences | null;
    if (raw?.version === 1) return validatePreferences(raw.values);
    const legacyTheme = window.localStorage.getItem("llama-board-theme");
    const legacyLocale = window.localStorage.getItem("llama-board-locale");
    return validatePreferences({
      theme: isTheme(legacyTheme) ? legacyTheme : "system",
      locale: isLocale(legacyLocale) ? legacyLocale : undefined,
    });
  } catch { return defaultPreferences(); }
}

/**
 * Whether a destructive action should stop for confirmation.
 *
 * Read at click time rather than captured in a prop so every panel honours the
 * current setting without threading preferences through the whole tree.
 */
export function shouldConfirmDestructive(): boolean {
  return loadPreferences().advanced.confirmDestructiveActions;
}

export function savePreferences(values: AppPreferences): void {
  try { window.localStorage.setItem(KEY, JSON.stringify({ version: 1, values: validatePreferences(values) } satisfies StoredPreferences)); } catch { /* storage is optional */ }
}
export function resetPreferences(): AppPreferences { const next = defaultPreferences(); savePreferences(next); return next; }

export function exportPreferences(values: AppPreferences): string {
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), preferences: validatePreferences(values) }, null, 2);
}

export function importPreferences(raw: string): AppPreferences {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid settings export.");
  const envelope = parsed as { schemaVersion?: unknown; preferences?: unknown };
  if (envelope.schemaVersion !== 1 || !envelope.preferences || typeof envelope.preferences !== "object") throw new Error("Unsupported settings export format.");
  return validatePreferences(envelope.preferences as Partial<AppPreferences>);
}
export { KEY as PREFERENCES_STORAGE_KEY };
