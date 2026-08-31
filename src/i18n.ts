import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { intlLocales, storedLocale, type Locale } from "./i18nCatalog";
import { translate, type TranslationVars, type UnifiedKey } from "./i18nUnified";

/**
 * React context wrapping the i18n catalogs: exposes the current `Locale` and a
 * `t()` bound to `i18nUnified.ts`'s `translate()`. Base app-chrome keys
 * (`i18nCatalog.ts`) are unprefixed; panel, extra, chat, and ui-domain strings
 * use the `panel.`, `extra.`, `chat.`, `ui.` namespaces respectively. Code
 * outside React that only has a `Locale` should call `translate()` directly.
 */

interface I18nValue { locale: Locale; setLocale: (locale: Locale) => void; t: (key: UnifiedKey, vars?: TranslationVars) => string; formatNumber: (value: number) => string; }
const I18nContext = createContext<I18nValue | null>(null);
export function I18nProvider({ initialLocale, onLocaleChange, children }: { initialLocale?: Locale; onLocaleChange?: (locale: Locale) => void; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? storedLocale());
  const setLocale = useCallback((next: Locale) => { setLocaleState(next); onLocaleChange?.(next); }, [onLocaleChange]);
  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars), formatNumber: (value) => new Intl.NumberFormat(intlLocales[locale]).format(value) }), [locale, setLocale]);
  return createElement(I18nContext.Provider, { value }, children);
}
export function useI18n(): I18nValue { const value = useContext(I18nContext); if (!value) throw new Error("useI18n must be used inside I18nProvider"); return value; }
export { detectLocale, intlLocales, messages, localeOptions } from "./i18nCatalog";
export type { Locale, TranslationKey } from "./i18nCatalog";
export { translate } from "./i18nUnified";
export type { UnifiedKey, TranslationVars } from "./i18nUnified";
