import type { AppConfig } from "../api";
import { useI18n } from "../i18n";
import type { NumericField, NumericKey } from "./tuningFields";

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
        return (
          <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={inputId} className="truncate text-sm text-slate-300">{field.label}</label>
              <span className={`shrink-0 text-[10px] ${field.server ? "text-amber-400" : "text-emerald-400"}`}>
                {field.server ? t("extra.serverSide") : t("extra.perRequest")}
              </span>
            </div>
            <input
              id={inputId}
              type="text"
              inputMode={field.step < 1 ? "decimal" : "numeric"}
              value={draft}
              step={field.step}
              min={field.min}
              max={field.max}
              onChange={(event) => onChange(field.key, event.target.value)}
              onBlur={(event) => onCommit(field, event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              disabled={disabled}
              className="w-full min-w-0 rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
            <span className="text-xs text-slate-500">{field.hint}</span>
          </div>
        );
      })}
    </>
  );
}
