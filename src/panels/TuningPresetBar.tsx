import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import StatusBadge from "../components/StatusBadge";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import type { TuningPhase } from "./useTuningController";

interface PendingBulkChange { title: string; description: string; confirmLabel: string; run: () => void }

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  phase: TuningPhase;
  flash: string | null;
  dismissFlash: () => void;
  changedServerFields: string[];
  relationWarnings: string[];
  busy: boolean;
  pendingBulkChange: PendingBulkChange | null;
  setPendingBulkChange: (value: PendingBulkChange | null) => void;
  applyRestart: () => void;
  applyPreset: (name: "CPU" | "Balanced" | "Max GPU") => void;
  resetDefaults: () => void;
}

export default function TuningPresetBar({
  t, phase, flash, dismissFlash, changedServerFields, relationWarnings, busy,
  pendingBulkChange, setPendingBulkChange, applyRestart, applyPreset, resetDefaults,
}: Props) {
  return (
    <>
      <div className="app-panel-feedback-layer" aria-live="polite">
        {flash && <FeedbackBanner tone={phase === "failed" ? "error" : "info"} onDismiss={dismissFlash}>{flash}</FeedbackBanner>}
        {phase === "dirty" && changedServerFields.length > 0 && (
          <FeedbackBanner tone="warning" title={t("ui.serverSettingsChangedCount", { count: changedServerFields.length })} action={{ label: t("extra.applyRestart"), onClick: applyRestart }}>
            {changedServerFields.join(" · ")} · {t("extra.conversationsRemainSaved")}
          </FeedbackBanner>
        )}
        {relationWarnings.length > 0 && (
          <FeedbackBanner tone="warning" title={t("error.attention")}>
            <ul className="list-disc space-y-1 pl-4">{relationWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </FeedbackBanner>
        )}
      </div>

      <div className="tuning-preset-bar mb-4 flex shrink-0 flex-wrap items-center gap-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("extra.tuningPresets")}</span>
        {(["CPU", "Balanced", "Max GPU"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setPendingBulkChange({
              title: t("ui.presetTitle", { name }),
              description: t("ui.presetBody", { name }),
              confirmLabel: t("ui.presetConfirm"),
              run: () => applyPreset(name),
            })}
            disabled={phase === "applying" || busy}
            className="rounded-lg border border-slate-700 app-bg-muted px-3 py-1.5 text-xs text-slate-200 app-bg-elevated disabled:opacity-40"
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPendingBulkChange({
            title: t("ui.loadProfileTitle"),
            description: t("ui.loadProfileBody"),
            confirmLabel: t("ui.loadProfileConfirm"),
            run: resetDefaults,
          })}
          disabled={phase === "applying" || busy}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 app-bg-muted disabled:opacity-40"
        >
          {t("ui.loadQwenProfile")}
        </button>
        {phase === "idle" && <StatusBadge label={t("extra.saved")} tone="success" />}
        {phase === "dirty" && <StatusBadge label={t("extra.restartRequired")} tone="warning" />}
        {phase === "applying" && <StatusBadge label={t("extra.applying")} tone="neutral" />}
        {phase === "failed" && <StatusBadge label={t("extra.applyFailed")} tone="danger" />}
        {phase === "dirty" && <span className="text-xs text-amber-300">{t("extra.previousValues")}</span>}
      </div>
      <ConfirmDialog
        open={pendingBulkChange !== null}
        title={pendingBulkChange?.title ?? ""}
        description={pendingBulkChange?.description ?? ""}
        confirmLabel={pendingBulkChange?.confirmLabel ?? t("common.confirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => { pendingBulkChange?.run(); setPendingBulkChange(null); }}
        onCancel={() => setPendingBulkChange(null)}
      />
    </>
  );
}
