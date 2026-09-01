import type { ReactNode } from "react";
import type { AppConfig } from "../api";
import Tooltip from "../components/Tooltip";
import { CustomSelect } from "../components/ThemeSwitcher";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import { SERVER_FIELDS, SERVER_TEXT_FIELDS, type NumericField, type NumericKey, type ServerTextKey } from "./tuningFields";
import TuningSpeculativeSection from "./TuningSpeculativeSection";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  cfg: AppConfig;
  disabled: boolean;
  numericDrafts: Partial<Record<NumericKey, string>>;
  onNumericChange: (key: NumericKey, value: string) => void;
  onNumericCommit: (field: NumericField, value: string) => void;
  updateFlash: (value: string) => void;
  serverTextValue: (key: ServerTextKey) => string;
  onServerTextChange: (key: ServerTextKey, value: string) => void;
  commitServerText: (key: ServerTextKey, value: string) => void;
  projectorEditable: boolean;
  serverSelectValue: (key: "spec_type" | "spec_draft_ngl") => string;
  selectServerText: (key: "spec_type" | "spec_draft_ngl", value: string) => void;
  applyRow: ReactNode;
  /** Advanced-only nested controls are omitted from the Quick view. */
  showAdvanced?: boolean;
  /** Field-level category slicing supplied by TuningPanel. */
  fields?: readonly NumericField[];
  showFlashAttention?: boolean;
  showProjector?: boolean;
  showSpeculative?: boolean;
  showCacheTypes?: boolean;
}

export default function TuningServerSection({
  t, cfg, disabled, numericDrafts, onNumericChange, onNumericCommit, updateFlash,
  serverTextValue, onServerTextChange, commitServerText, projectorEditable,
  serverSelectValue, selectServerText, applyRow, showAdvanced = true,
  fields = SERVER_FIELDS, showFlashAttention = true, showProjector = true,
  showSpeculative = true, showCacheTypes = true,
}: Props) {
  const projectorTooltip = SERVER_TEXT_FIELDS.find((field) => field.key === "mmproj")?.tooltip;
  const cacheKeyField = SERVER_TEXT_FIELDS.find((field) => field.key === "cache_type_k");
  const cacheValueField = SERVER_TEXT_FIELDS.find((field) => field.key === "cache_type_v");
  const cacheFields = [cacheKeyField, cacheValueField].filter((field): field is NonNullable<typeof field> => Boolean(field));
  return (
    <section className="tuning-section tuning-section--server min-w-0 rounded-xl border border-slate-700 app-bg-muted p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-200">{t("section.serverMemory")}</h2>
      <p className="mb-4 text-xs text-slate-500">{t("ui.serverMemoryHint")}</p>
      {fields.length > 0 && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><NumericFieldGrid fields={fields} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} /></div>}
      {showFlashAttention && <div className="mt-4 flex min-w-0 flex-col gap-1.5 sm:max-w-[calc(50%-0.5rem)]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <label htmlFor="tuning-flash-attn" className="text-sm text-slate-300">{t("ui.flashAttention")}</label>
            <Tooltip content={{ title: "Flash attention", description: "Use the runtime's flash-attention kernels when available." }} label={`Help for ${t("ui.flashAttention")}`} id="tuning-flash-attn-help" />
          </div>
          <span className="shrink-0 text-[10px] text-amber-400">{t("extra.serverSide")}</span>
        </div>
        <CustomSelect
          id="tuning-flash-attn"
          value={cfg.flash_attn === "on" || cfg.flash_attn === "off" ? cfg.flash_attn : "auto"}
          options={[
            { value: "auto", label: "auto" },
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ]}
          onChange={updateFlash}
          disabled={disabled}
          className="w-full"
        />
        <span className="text-xs text-slate-500">{t("ui.flashAttentionHint")}</span>
      </div>}

      {showCacheTypes && showAdvanced && cacheFields.length > 0 && (
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          {cacheFields.map((field) => {
            const inputId = `tuning-${field.key}`;
            const value = serverTextValue(field.key);
            return (
              <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <label htmlFor={inputId} className="truncate text-sm text-slate-300">{field.label}</label>
                  <Tooltip content={field.tooltip} label={`Help for ${field.label}`} id={`${inputId}-help`} />
                </div>
                <CustomSelect
                  id={inputId}
                  value={field.options?.includes(value) ? value : (field.options?.[0] ?? value)}
                  options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
                  onChange={(next) => {
                    onServerTextChange(field.key, next);
                    commitServerText(field.key, next);
                  }}
                  disabled={disabled}
                  className="w-full"
                />
                <span className="text-xs text-slate-500">Restart required. Lower precision reduces KV memory.</span>
              </div>
            );
          })}
        </div>
      )}

      {showAdvanced && (showProjector || showSpeculative) && (
        <>
          {showProjector && <div className="mt-4 flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <label htmlFor="tuning-mmproj" className="text-sm text-slate-300">{t("ui.mmprojLabel")}</label>
                {projectorTooltip && <Tooltip content={projectorTooltip} label={`Help for ${t("ui.mmprojLabel")}`} id="tuning-mmproj-help" />}
              </div>
              <span className="shrink-0 text-[10px] text-amber-400">{t("extra.serverSide")}</span>
            </div>
            <input
              id="tuning-mmproj"
              value={serverTextValue("mmproj")}
              onChange={(event) => onServerTextChange("mmproj", event.target.value)}
              onBlur={(event) => commitServerText("mmproj", event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              disabled={!projectorEditable || disabled}
              placeholder={t("ui.mmprojPlaceholder")}
              className="app-input mt-1"
            />
            <span className="text-xs text-slate-500">{t("ui.mmprojHint")}</span>
          </div>}

          {showSpeculative && <TuningSpeculativeSection
            cfg={cfg}
            t={t}
            disabled={disabled}
            numericDrafts={numericDrafts}
            onNumericChange={onNumericChange}
            onNumericCommit={onNumericCommit}
            serverTextValue={serverTextValue}
            serverSelectValue={serverSelectValue}
            selectServerText={selectServerText}
            onServerTextChange={onServerTextChange}
            commitServerText={commitServerText}
          />}
        </>
      )}
      {applyRow}
    </section>
  );
}
