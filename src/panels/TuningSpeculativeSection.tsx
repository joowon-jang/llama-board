import type { AppConfig } from "../api";
import Tooltip from "../components/Tooltip";
import { CustomSelect } from "../components/ThemeSwitcher";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import NumericFieldGrid from "./NumericFieldGrid";
import { MTP_FIELDS, SERVER_TEXT_FIELDS, type NumericField, type NumericKey, type ServerTextKey } from "./tuningFields";
import { SPEC_DRAFT_NGL_OPTIONS, SPEC_TYPE_OPTIONS } from "./tuningValidation";

type SpecSelectKey = Extract<ServerTextKey, "spec_type" | "spec_draft_ngl">;
type SpecTextKey = Extract<ServerTextKey, "spec_type" | "spec_draft_ngl" | "spec_draft_device" | "spec_draft_model">;

interface Props {
  cfg: AppConfig;
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  disabled: boolean;
  numericDrafts: Partial<Record<NumericKey, string>>;
  onNumericChange: (key: NumericKey, value: string) => void;
  onNumericCommit: (field: NumericField, value: string) => void;
  serverTextValue: (key: SpecTextKey) => string;
  serverSelectValue: (key: SpecSelectKey) => string;
  selectServerText: (key: SpecSelectKey, value: string) => void;
  onServerTextChange: (key: SpecTextKey, value: string) => void;
  commitServerText: (key: SpecTextKey, value: string) => void;
}

/** Presentational: the "Speculative decoding" sub-section of the server tuning form. */
export default function TuningSpeculativeSection({
  cfg, t, disabled, numericDrafts, onNumericChange, onNumericCommit,
  serverTextValue, serverSelectValue, selectServerText, onServerTextChange, commitServerText,
}: Props) {
  const tooltipFor = (key: SpecTextKey) => SERVER_TEXT_FIELDS.find((field) => field.key === key)?.tooltip;
  return (
    <div className="mt-5 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
      <h3 className="app-section-title">{t("ui.specTitle")}</h3>
      <p className="app-section-hint mb-4">{t("ui.specHint")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor="tuning-spec-type" className="text-sm text-slate-300">{t("ui.specTypeLabel")}</label>
              {tooltipFor("spec_type") && <Tooltip content={tooltipFor("spec_type")!} label={`Help for ${t("ui.specTypeLabel")}`} id="tuning-spec-type-help" />}
            </div>
            <span className="shrink-0 text-[10px] text-amber-400">{t("extra.serverSide")}</span>
          </div>
          <CustomSelect
            id="tuning-spec-type"
            value={serverSelectValue("spec_type")}
            options={[
              ...SPEC_TYPE_OPTIONS.map((val) => ({ value: val, label: val })),
              { value: "custom", label: t("ui.customCommaList") },
            ]}
            onChange={(val) => selectServerText("spec_type", val)}
            disabled={disabled}
            className="w-full"
          />
          <div className="tuning-custom-input-slot">
            {serverSelectValue("spec_type") === "custom" && (
              <input
                aria-label={t("ui.customValueFor", { label: t("ui.specTypeLabel") })}
                value={serverTextValue("spec_type")}
                onChange={(event) => onServerTextChange("spec_type", event.target.value)}
                onBlur={(event) => commitServerText("spec_type", event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                disabled={disabled}
                placeholder="draft-mtp,ngram-mod"
                className="app-input font-mono"
              />
            )}
          </div>
          <span className="text-xs text-slate-500">{t("ui.specTypeHint")}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor="tuning-spec-draft-ngl" className="text-sm text-slate-300">{t("ui.specDraftNglLabel")}</label>
              {tooltipFor("spec_draft_ngl") && <Tooltip content={tooltipFor("spec_draft_ngl")!} label={`Help for ${t("ui.specDraftNglLabel")}`} id="tuning-spec-draft-ngl-help" />}
            </div>
            <span className="shrink-0 text-[10px] text-amber-400">{t("extra.serverSide")}</span>
          </div>
          <CustomSelect
            id="tuning-spec-draft-ngl"
            value={serverSelectValue("spec_draft_ngl")}
            options={[
              ...SPEC_DRAFT_NGL_OPTIONS.map((val) => ({ value: val, label: val })),
              { value: "custom", label: t("ui.customNumeric") },
            ]}
            onChange={(val) => selectServerText("spec_draft_ngl", val)}
            disabled={disabled}
            className="w-full"
          />
          <div className="tuning-custom-input-slot">
            {serverSelectValue("spec_draft_ngl") === "custom" && (
              <input
                aria-label={t("ui.customValueFor", { label: t("ui.specDraftNglLabel") })}
                value={serverTextValue("spec_draft_ngl")}
                onChange={(event) => onServerTextChange("spec_draft_ngl", event.target.value)}
                onBlur={(event) => commitServerText("spec_draft_ngl", event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                disabled={disabled}
                placeholder="32"
                inputMode="numeric"
                className="app-input"
              />
            )}
          </div>
          <span className="text-xs text-slate-500">{t("ui.specDraftNglHint")}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor="tuning-spec-draft-device" className="text-sm text-slate-300">{t("ui.specDraftDeviceLabel")}</label>
              {tooltipFor("spec_draft_device") && <Tooltip content={tooltipFor("spec_draft_device")!} label={`Help for ${t("ui.specDraftDeviceLabel")}`} id="tuning-spec-draft-device-help" />}
            </div>
            <span className="shrink-0 text-[10px] text-amber-400">{t("extra.serverSide")}</span>
          </div>
          <input
            id="tuning-spec-draft-device"
            value={serverTextValue("spec_draft_device")}
            onChange={(event) => onServerTextChange("spec_draft_device", event.target.value)}
            onBlur={(event) => commitServerText("spec_draft_device", event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={disabled}
            placeholder={t("ui.specDraftDevicePlaceholder")}
            className="w-full rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
          <span className="text-xs text-slate-500">{t("ui.specDraftDeviceHint")}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <label htmlFor="tuning-spec-draft-model" className="text-sm text-slate-300">{t("ui.specDraftModelLabel")}</label>
              {tooltipFor("spec_draft_model") && <Tooltip content={tooltipFor("spec_draft_model")!} label={`Help for ${t("ui.specDraftModelLabel")}`} id="tuning-spec-draft-model-help" />}
            </div>
            <span className="shrink-0 text-[10px] text-amber-400">{t("extra.serverSide")}</span>
          </div>
          <input
            id="tuning-spec-draft-model"
            value={serverTextValue("spec_draft_model")}
            onChange={(event) => onServerTextChange("spec_draft_model", event.target.value)}
            onBlur={(event) => commitServerText("spec_draft_model", event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={disabled}
            placeholder={t("ui.specDraftModelPlaceholder")}
            className="w-full rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
          <span className="text-xs text-slate-500">{t("ui.specDraftModelHint")}</span>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumericFieldGrid fields={MTP_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={disabled} onChange={onNumericChange} onCommit={onNumericCommit} />
      </div>
    </div>
  );
}
