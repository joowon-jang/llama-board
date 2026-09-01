import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "../api";
import Tooltip from "../components/Tooltip";
import { CustomSelect } from "../components/ThemeSwitcher";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import { clampNumber } from "./tuningValidation";
import { chatOptionValue, tuningFieldHint, tuningFieldLabel, tuningFieldTooltip, type ChatOptionField } from "./tuningFields";
import TuningSliderField from "./TuningSliderField";

interface Props {
  cfg: AppConfig;
  field: ChatOptionField;
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  disabled: boolean;
  chatOptionDrafts: Record<string, string>;
  setChatOptionDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  chatOptionSelectModes: Record<string, "select" | "custom">;
  setChatOptionSelectModes: Dispatch<SetStateAction<Record<string, "select" | "custom">>>;
  onCommit: (field: ChatOptionField, value: string) => void;
}

export default function TuningChatOptionField({
  cfg, field, t, disabled, chatOptionDrafts, setChatOptionDrafts,
  chatOptionSelectModes, setChatOptionSelectModes, onCommit,
}: Props) {
  const current = clampNumber(chatOptionValue(cfg, field), field.min, field.max, field.defaultValue);
  const draft = chatOptionDrafts[field.key] ?? String(current);
  const inputId = `tuning-${field.key}`;
  const label = tuningFieldLabel(t as never, field);
  const hint = tuningFieldHint(t as never, field);
  const tooltip = tuningFieldTooltip(t as never, field);
  const selectValue = field.options
    ? (chatOptionSelectModes[field.key] === "custom" || !field.options.some((option) => String(option.value) === draft) ? "custom" : draft)
    : null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {field.options && <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <label htmlFor={inputId} className="truncate text-sm text-slate-300">{label}</label>
          <Tooltip content={tooltip} label={`Help for ${label}`} id={`${inputId}-help`} />
        </div>
        <span className="shrink-0 text-[10px] text-emerald-400">{t("extra.perRequest")}</span>
      </div>}
      {field.options ? (
        <>
          <CustomSelect
            id={inputId}
            value={selectValue ?? "custom"}
            options={[
              ...field.options.map((opt) => ({ value: String(opt.value), label: opt.label })),
              { value: "custom", label: t("ui.customNumeric") },
            ]}
            onChange={(value) => {
              if (value === "custom") {
                setChatOptionSelectModes((modes) => ({ ...modes, [field.key]: "custom" }));
                setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: draft }));
              } else {
                setChatOptionSelectModes((modes) => {
                  const next = { ...modes };
                  delete next[field.key];
                  return next;
                });
                setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: value }));
                onCommit(field, value);
              }
            }}
            disabled={disabled}
            className="w-full"
          />
          <div className="tuning-custom-input-slot">
            {selectValue === "custom" && (
              <input
                aria-label={t("ui.customValueFor", { label })}
                type="text"
                inputMode="numeric"
                value={draft}
                step={field.step}
                min={field.min}
                max={field.max}
                onChange={(event) => setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: event.target.value }))}
                onBlur={(event) => onCommit(field, event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                disabled={disabled}
                className="w-full min-w-0 rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            )}
          </div>
        </>
      ) : (
        <TuningSliderField
          id={inputId}
          label={label}
          min={field.min}
          max={field.max}
          step={field.step}
          hint={hint}
          value={draft}
          onChange={(value) => setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: value }))}
          onCommit={(value) => onCommit(field, value)}
          disabled={disabled}
          labelExtra={<Tooltip content={tooltip} label={`Help for ${label}`} id={`${inputId}-slider-help`} />}
          valueMeta={<span className="shrink-0 text-[10px] text-emerald-400">{t("extra.perRequest")}</span>}
        />
      )}
      <span className="text-xs text-slate-500">{hint}</span>
    </div>
  );
}
