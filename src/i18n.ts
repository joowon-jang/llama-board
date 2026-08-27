import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { intlLocales, messages, storedLocale, type Locale, type TranslationKey } from "./i18nCatalog";

interface I18nValue { locale: Locale; setLocale: (locale: Locale) => void; t: (key: TranslationKey) => string; formatNumber: (value: number) => string; }
const I18nContext = createContext<I18nValue | null>(null);
export function I18nProvider({ initialLocale, onLocaleChange, children }: { initialLocale?: Locale; onLocaleChange?: (locale: Locale) => void; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? storedLocale());
  const setLocale = useCallback((next: Locale) => { setLocaleState(next); onLocaleChange?.(next); }, [onLocaleChange]);
  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: (key) => messages[locale][key] ?? messages.en[key] ?? key, formatNumber: (value) => new Intl.NumberFormat(intlLocales[locale]).format(value) }), [locale, setLocale]);
  return createElement(I18nContext.Provider, { value }, children);
}
export function useI18n(): I18nValue { const value = useContext(I18nContext); if (!value) throw new Error("useI18n must be used inside I18nProvider"); return value; }
export { detectLocale, intlLocales, messages, localeOptions } from "./i18nCatalog";
export type { Locale, TranslationKey } from "./i18nCatalog";
