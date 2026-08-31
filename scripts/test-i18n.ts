import assert from "node:assert/strict";
import { messages, localeOptions, type TranslationKey } from "../src/i18nCatalog.ts";
import { chatText, type ChatTextKey } from "../src/chatI18n.ts";
import { panelText, type PanelTextKey } from "../src/panelI18n.ts";
import { extraText, type ExtraTextKey } from "../src/extraI18n.ts";
import { uiText, type UiTextKey } from "../src/uiI18n.ts";
import { translate } from "../src/i18nUnified.ts";

const locales = ["ko", "en", "ja", "zh"] as const;
const keys = Object.keys(messages.en) as TranslationKey[];
const chatKeys = Object.keys(chatText.en) as ChatTextKey[];
const panelKeys = Object.keys(panelText.en) as PanelTextKey[];
const extraKeys = Object.keys(extraText.en) as ExtraTextKey[];
const uiKeys = Object.keys(uiText.en) as UiTextKey[];
const buildPhaseKeys = [
  "buildPhaseResolving",
  "buildPhaseDownloading",
  "buildPhaseDownloadingSource",
  "buildPhaseVerified",
  "buildPhaseRecordedSourceDigest",
  "buildPhaseExtracting",
  "buildPhaseExtractingSource",
  "buildPhaseConfiguring",
  "buildPhaseBuilding",
  "buildPhasePackaging",
  "buildPhasePreflight",
  "buildPhaseInstalled",
  "buildPhaseCleaningUp",
  "buildPhaseWorking",
] as const;
for (const locale of locales) {
  for (const key of keys) {
    assert.equal(typeof messages[locale][key], "string", `${locale} is missing ${key}`);
    assert.notEqual(messages[locale][key].trim(), "", `${locale}.${key} is empty`);
  }
  for (const key of chatKeys) {
    assert.equal(typeof chatText[locale][key], "string", `${locale} is missing chat key ${key}`);
    assert.notEqual(chatText[locale][key].trim(), "", `${locale}.chat.${key} is empty`);
  }
  for (const key of panelKeys) {
    assert.equal(typeof panelText[locale][key], "string", `${locale} is missing panel key ${key}`);
    assert.notEqual(panelText[locale][key].trim(), "", `${locale}.panel.${key} is empty`);
  }
  for (const key of uiKeys) {
    assert.equal(typeof uiText[locale][key], "string", `${locale} is missing ui key ${key}`);
    assert.notEqual(uiText[locale][key].trim(), "", `${locale}.ui.${key} is empty`);
  }
  for (const key of extraKeys) {
    assert.equal(typeof extraText[locale][key], "string", `${locale} is missing extra key ${key}`);
    assert.notEqual(extraText[locale][key].trim(), "", `${locale}.extra.${key} is empty`);
  }
  if (locale !== "en") {
    for (const key of buildPhaseKeys) {
      assert.notEqual(uiText[locale][key], uiText.en[key], `${locale}.ui.${key} must be translated`);
    }
  }
}
assert.deepEqual(localeOptions.map((item) => item.value), ["ko", "en", "ja", "zh"]);

// Unified accessor: every namespaced key must route to the same string its
// catalog would return directly, for all four locales.
for (const locale of locales) {
  for (const key of keys) assert.equal(translate(locale, key), messages[locale][key], `translate(${locale}, ${key}) mismatch`);
  for (const key of chatKeys) assert.equal(translate(locale, `chat.${key}`), chatText[locale][key], `translate(${locale}, chat.${key}) mismatch`);
  for (const key of panelKeys) assert.equal(translate(locale, `panel.${key}`), panelText[locale][key], `translate(${locale}, panel.${key}) mismatch`);
  for (const key of uiKeys) assert.equal(translate(locale, `ui.${key}`), uiText[locale][key], `translate(${locale}, ui.${key}) mismatch`);
  for (const key of extraKeys) assert.equal(translate(locale, `extra.${key}`), extraText[locale][key], `translate(${locale}, extra.${key}) mismatch`);
}

// Placeholder substitution: uniform across all four namespaces, matching the
// {name} substitution uiI18n's former `ut()` performed.
assert.equal(translate("en", "ui.installedOk", { backend: "cuda", build: "123" }), uiText.en.installedOk.replace("{backend}", "cuda").replace("{build}", "123"));
assert.equal(translate("ko", "extra.presetLoaded", { name: "Balanced" }), extraText.ko.presetLoaded.replace("{name}", "Balanced"));
assert.equal(translate("en", "chat.deleteBody", { title: "My chat" }), chatText.en.deleteBody.replace("{title}", "My chat"));

// A missing var leaves the placeholder untouched, same as uiI18n's former `ut()`.
assert.equal(translate("en", "ui.installedOk", {}), uiText.en.installedOk);

// Runtime fallback: unknown keys consistently return the bare key across the
// unified namespaces. Typed production calls cannot normally reach this path,
// but the contract protects dynamic inputs from returning undefined.
assert.equal(translate("ko", "ui.__missing__" as never), "__missing__");
assert.equal(translate("ko", "panel.__missing__" as never), "__missing__");
assert.equal(translate("ko", "extra.__missing__" as never), "__missing__");
assert.equal(translate("ko", "chat.__missing__" as never), "__missing__");
assert.equal(translate("ko", "error.__missing__" as never), "error.__missing__");

// Locale fallback: temporarily remove a known key from each locale catalog so
// the central accessor must use the English value, then restore the fixture.
function assertLocaleFallback(catalog: { en: Record<string, string>; ko: Record<string, string> }, key: string, unifiedKey: string): void {
  const local = catalog.ko;
  const original = local[key];
  delete local[key];
  try {
    assert.equal(translate("ko", unifiedKey as never), catalog.en[key], `${unifiedKey} did not fall back to en`);
  } finally {
    local[key] = original;
  }
}

assertLocaleFallback(messages, "error.tryAgain", "error.tryAgain");
assertLocaleFallback(uiText, "installedOk", "ui.installedOk");
assertLocaleFallback(panelText, "models", "panel.models");
assertLocaleFallback(extraText, "presetLoaded", "extra.presetLoaded");
assertLocaleFallback(chatText, "deleteBody", "chat.deleteBody");

console.log(`i18n catalog and preference validation passed (${keys.length} app keys, ${chatKeys.length} chat keys, ${panelKeys.length} panel keys, ${extraKeys.length} extra keys, ${uiKeys.length} ui keys, 4 locales)`);
console.log("unified translate() namespace routing, placeholder substitution, and fallback verified");
