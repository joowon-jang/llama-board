import type { AppConfig } from "../api";
import Tooltip from "../components/Tooltip";
import { useI18n } from "../i18n";
import TuningSliderField from "./TuningSliderField";
import { tuningFieldHint, tuningFieldLabel, tuningFieldTooltip, type NumericField, type NumericKey } from "./tuningFields";

interface NumericFieldGridProps {
  fields: readonly NumericField[];
  cfg: AppConfig;
  drafts: Partial<Record<NumericKey, string>>;
  disabled: boolean;
  onChange: (key: NumericKey, value: string) => void;
  onCommit: (field: NumericField, value: string) => void;
}

export default function NumericFieldGrid({ fields, cfg, drafts, disabled, onChange, onCommit }: NumericFieldGridProps) {
  const { t } = useI18n();
  return (
    <>
      {fields.map((field) => {
        const current = typeof cfg[field.key] === "number" ? cfg[field.key] as number : field.min;
        const draft = drafts[field.key] ?? String(current);
        const inputId = `tuning-${field.key}`;
        const label = tuningFieldLabel(t, field);
        const hint = tuningFieldHint(t, field);
        const tooltip = tuningFieldTooltip(t, field);
        return (
          <TuningSliderField
            key={field.key}
            id={inputId}
            label={label}
            min={field.min}
            max={field.max}
            step={field.step}
            hint={hint}
            value={draft}
            onChange={(value) => onChange(field.key, value)}
            onCommit={(value) => onCommit(field, value)}
            disabled={disabled}
            labelExtra={<Tooltip content={tooltip} label={`Help for ${label}`} id={`${inputId}-help`} />}
            valueMeta={<span className={`shrink-0 text-[10px] ${field.server ? "text-amber-400" : "text-emerald-400"}`}>
              {field.server ? t("extra.serverSide") : t("extra.perRequest")}
            </span>}
          />
        );
      })}
    </>
  );
}
