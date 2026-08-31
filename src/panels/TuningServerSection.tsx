import type { ReactNode } from "react";
import type { AppConfig } from "../api";
import { CustomSelect } from "../components/ThemeSwitcher";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import { SERVER_FIELDS, type NumericField, type NumericKey, type ServerTextKey } from "./tuningFields";
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
}

export default function TuningServerSection({
  t, cfg, disabled, numericDrafts, onNumericChange, onNumericCommit, updateFlash,
  serverTextValue, onServerTextChange, commitServerText, projectorEditable,
  serverSelectValue, selectServerText, applyRow,
}: Props) {
  return (
    <section className="tuning-section tuning-section--server min-w-0 rounded-xl border border-slate-700 app-bg-muted p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-200">{t("section.serverMemory")}</h2>
      <p className="mb-4 text-xs text-slate-500">{t("ui.serverMemoryHint")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><NumericFieldGrid fields={SERVER_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} /></div>
      <div className="mt-4 flex min-w-0 flex-col gap-1.5 sm:max-w-[calc(50%-0.5rem)]">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="tuning-flash-attn" className="text-sm text-slate-300">{t("ui.flashAttention")}</label>
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
      </div>

      <div className="mt-4 flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="tuning-mmproj" className="text-sm text-slate-300">{t("ui.mmprojLabel")}</label>
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
      </div>

      <TuningSpeculativeSection
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
      />
      {applyRow}
    </section>
  );
}
