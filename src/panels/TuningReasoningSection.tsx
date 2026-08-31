import type { ReactNode } from "react";
import type { AppConfig } from "../api";
import { CustomSelect } from "../components/ThemeSwitcher";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import { REASONING_FIELDS, type NumericField, type NumericKey } from "./tuningFields";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  cfg: AppConfig;
  disabled: boolean;
  numericDrafts: Partial<Record<NumericKey, string>>;
  onNumericChange: (key: NumericKey, value: string) => void;
  onNumericCommit: (field: NumericField, value: string) => void;
  updateServerText: (key: "reasoning" | "reasoning_format" | "reasoning_preserve", value: string) => void;
  updateReasoningEffort: (value: string) => void;
  reasoningBudgetMessageValue: string;
  onReasoningBudgetMessageChange: (value: string) => void;
  onReasoningBudgetMessageCommit: (value: string) => void;
  applyRow: ReactNode;
}

export default function TuningReasoningSection({
  t, cfg, disabled, numericDrafts, onNumericChange, onNumericCommit,
  updateServerText, updateReasoningEffort, reasoningBudgetMessageValue,
  onReasoningBudgetMessageChange, onReasoningBudgetMessageCommit, applyRow,
}: Props) {
  return (
    <section className="tuning-section tuning-section--reasoning min-w-0 rounded-xl border border-slate-700 app-bg-muted p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-200">{t("section.reasoning")}</h2>
      <p className="mb-4 text-xs text-slate-500">{t("extra.reasoningDescription")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="tuning-reasoning" className="text-sm text-slate-300">{t("ui.reasoningMode")}</label>
          <CustomSelect
            id="tuning-reasoning"
            value={cfg.reasoning}
            options={[
              { value: "auto", label: "auto" },
              { value: "on", label: "on" },
              { value: "off", label: "off" },
            ]}
            onChange={(val) => updateServerText("reasoning", val)}
            disabled={disabled}
            className="w-full"
          />
          <span className="text-xs text-slate-500">--reasoning.</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="tuning-reasoning-format" className="text-sm text-slate-300">{t("ui.reasoningFormat")}</label>
          <CustomSelect
            id="tuning-reasoning-format"
            value={cfg.reasoning_format}
            options={[
              { value: "auto", label: "auto" },
              { value: "none", label: "none" },
              { value: "deepseek", label: "deepseek" },
              { value: "deepseek-legacy", label: "deepseek-legacy" },
            ]}
            onChange={(val) => updateServerText("reasoning_format", val)}
            disabled={disabled}
            className="w-full"
          />
          <span className="text-xs text-slate-500">--reasoning-format.</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="tuning-reasoning-preserve" className="text-sm text-slate-300">{t("ui.reasoningPreserve")}</label>
          <CustomSelect
            id="tuning-reasoning-preserve"
            value={cfg.reasoning_preserve}
            options={[
              { value: "auto", label: t("ui.templateDefault") },
              { value: "on", label: "on" },
              { value: "off", label: "off" },
            ]}
            onChange={(val) => updateServerText("reasoning_preserve", val)}
            disabled={disabled}
            className="w-full"
          />
          <span className="text-xs text-slate-500">--reasoning-preserve / --no-reasoning-preserve.</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="tuning-reasoning-effort" className="text-sm text-slate-300">{t("ui.reasoningEffort")}</label>
            <span className="shrink-0 text-[10px] text-amber-400">{t("ui.serverAndRequest")}</span>
          </div>
          <CustomSelect
            id="tuning-reasoning-effort"
            value={cfg.reasoning_effort}
            options={[
              { value: "default", label: "default" },
              { value: "none", label: "none" },
              { value: "minimal", label: "minimal" },
              { value: "low", label: "low" },
              { value: "medium", label: "medium" },
              { value: "high", label: "high" },
              { value: "xhigh", label: "xhigh" },
              { value: "max", label: "max" },
            ]}
            onChange={(val) => updateReasoningEffort(val)}
            disabled={disabled}
            className="w-full"
          />
          <span className="text-xs text-slate-500">{t("ui.reasoningEffortHint")}</span>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumericFieldGrid fields={REASONING_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="tuning-reasoning-budget-message" className="text-sm text-slate-300">{t("ui.budgetMessageLabel")}</label>
          <input
            id="tuning-reasoning-budget-message"
            value={reasoningBudgetMessageValue}
            onChange={(event) => onReasoningBudgetMessageChange(event.target.value)}
            onBlur={(event) => onReasoningBudgetMessageCommit(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={disabled}
            placeholder={t("ui.optional")}
            className="app-input mt-1"
          />
          <span className="text-xs text-slate-500">{t("ui.budgetMessageHint")}</span>
        </div>
      </div>
      {applyRow}
    </section>
  );
}
