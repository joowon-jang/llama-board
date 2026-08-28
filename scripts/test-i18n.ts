import assert from "node:assert/strict";
import { messages, localeOptions } from "../src/i18nCatalog.ts";
import { chatText } from "../src/chatI18n.ts";
import { panelText } from "../src/panelI18n.ts";
import { extraText } from "../src/extraI18n.ts";
import { uiText } from "../src/uiI18n.ts";

const locales = ["ko", "en", "ja", "zh"] as const;
const keys = Object.keys(messages.en);
const chatKeys = Object.keys(chatText.en);
const panelKeys = Object.keys(panelText.en);
const extraKeys = Object.keys(extraText.en);
const uiKeys = Object.keys(uiText.en);
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
console.log(`i18n catalog and preference validation passed (${keys.length} app keys, ${chatKeys.length} chat keys, ${panelKeys.length} panel keys, ${extraKeys.length} extra keys, ${uiKeys.length} ui keys, 4 locales)`);
