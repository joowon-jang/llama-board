import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "../api";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import { ADVANCED_SAMPLING_FIELDS, SAMPLING_FIELDS, type ChatOptionField, type NumericField, type NumericKey } from "./tuningFields";
import TuningChatOptionField from "./TuningChatOptionField";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  cfg: AppConfig;
  disabled: boolean;
  numericDrafts: Partial<Record<NumericKey, string>>;
  onNumericChange: (key: NumericKey, value: string) => void;
  onNumericCommit: (field: NumericField, value: string) => void;
  chatOptionDrafts: Record<string, string>;
  setChatOptionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  chatOptionSelectModes: Record<string, "select" | "custom">;
  setChatOptionSelectModes: Dispatch<SetStateAction<Record<string, "select" | "custom">>>;
  onChatOptionCommit: (field: ChatOptionField, value: string) => void;
}

export default function TuningSamplingSection({
  t, cfg, disabled, numericDrafts, onNumericChange, onNumericCommit,
  chatOptionDrafts, setChatOptionDrafts, chatOptionSelectModes, setChatOptionSelectModes, onChatOptionCommit,
}: Props) {
  return (
    <section className="tuning-section tuning-section--sampling min-w-0 rounded-xl border border-slate-700 app-bg-muted p-4">
      <h2 className="app-section-title">{t("section.sampling")}</h2>
      <p className="app-section-hint mb-4">{t("ui.samplingHint")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><NumericFieldGrid fields={SAMPLING_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} /></div>

      <details className="mt-5 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{t("extra.moreSampling")}</summary>
        <p className="app-section-hint mb-4 mt-2">{t("ui.advancedSamplingHint")}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {ADVANCED_SAMPLING_FIELDS.map((field) => (
            <TuningChatOptionField
              key={field.key}
              cfg={cfg}
              field={field}
              t={t}
              disabled={disabled}
              chatOptionDrafts={chatOptionDrafts}
              setChatOptionDrafts={setChatOptionDrafts}
              chatOptionSelectModes={chatOptionSelectModes}
              setChatOptionSelectModes={setChatOptionSelectModes}
              onCommit={onChatOptionCommit}
            />
          ))}
        </div>
      </details>
      <div className="mt-5 text-xs text-slate-500">{t("extra.savedNextMessage")}</div>
    </section>
  );
}
