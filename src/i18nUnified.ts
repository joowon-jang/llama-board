import { messages, type Locale, type TranslationKey } from "./i18nCatalog.ts";
import { uiText, type UiTextKey } from "./uiI18n.ts";
import { panelText, type PanelTextKey } from "./panelI18n.ts";
import { extraText, type ExtraTextKey } from "./extraI18n.ts";
import { chatText, type ChatTextKey } from "./chatI18n.ts";

/**
 * Single namespaced accessor over the five i18n catalogs. Base app-chrome keys
 * (`i18nCatalog.ts`) keep their unprefixed names; the other four catalogs are
 * addressed as `ui.<key>`, `panel.<key>`, `extra.<key>`, `chat.<key>`. This is
 * the only place that routes a key to its catalog and substitutes `{name}`
 * placeholders — the catalogs themselves hold only data, key types, and
 * completeness asserts. Unknown runtime keys consistently return the bare key,
 * matching the existing base/ui fallback and keeping dynamic lookup safe.
 */
export type UnifiedKey =
  | TranslationKey
  | `ui.${UiTextKey}`
  | `panel.${PanelTextKey}`
  | `extra.${ExtraTextKey}`
  | `chat.${ChatTextKey}`;

export type TranslationVars = Record<string, string | number>;

function substitute(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function translate(locale: Locale, key: UnifiedKey, vars?: TranslationVars): string {
  if (key.startsWith("ui.")) {
    const k = key.slice(3) as UiTextKey;
    return substitute(uiText[locale][k] ?? uiText.en[k] ?? k, vars);
  }
  if (key.startsWith("panel.")) {
    const k = key.slice(6) as PanelTextKey;
    return substitute(panelText[locale][k] ?? panelText.en[k] ?? k, vars);
  }
  if (key.startsWith("extra.")) {
    const k = key.slice(6) as ExtraTextKey;
    return substitute(extraText[locale][k] ?? extraText.en[k] ?? k, vars);
  }
  if (key.startsWith("chat.")) {
    const k = key.slice(5) as ChatTextKey;
    return substitute(chatText[locale][k] ?? chatText.en[k] ?? k, vars);
  }
  const k = key as TranslationKey;
  return substitute(messages[locale][k] ?? messages.en[k] ?? k, vars);
}
