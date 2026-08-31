import type { AppStore } from "../store";
import { useI18n } from "../i18n";
import { useTuningController } from "./useTuningController";
import TuningPresetBar from "./TuningPresetBar";
import TuningServerSection from "./TuningServerSection";
import TuningReasoningSection from "./TuningReasoningSection";
import TuningSamplingSection from "./TuningSamplingSection";
import TuningEscapeSection from "./TuningEscapeSection";

/** Tuning panel: server-side values require restart; sampling applies next chat. */
export default function TuningPanel({ store, section = "server", applyRequest = 0 }: { store: AppStore; section?: "server" | "sampling" | "reasoning" | "escape"; applyRequest?: number }) {
  const { t } = useI18n();
  const tuning = useTuningController(store, applyRequest);
  const { cfg } = tuning;

  if (!cfg) {
    return (
      <div className="app-page-scroll tuning-panel flex h-full min-h-0 flex-col p-4">
        <div className="panel-loading" role="status" aria-label={t("extra.loading")}>
          <span className="panel-spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }

  // Both server-side sections need the same restart affordance.
  const applyRow = (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => void tuning.applyRestart()}
        disabled={tuning.phase === "applying" || store.busy}
        className="app-button app-button--primary"
      >
        {tuning.phase === "applying" ? t("extra.applying") : t("extra.applyRestart")}
      </button>
      <span className="text-xs text-slate-500">
        {store.status.state === "running" ? t("extra.serverRunning") : t("extra.serverStopped")}
      </span>
    </div>
  );

  return (
    <div className="app-page-scroll tuning-panel relative flex h-full min-h-0 flex-col p-4" data-tuning-section={section}>
      <TuningPresetBar
        t={t}
        phase={tuning.phase}
        flash={tuning.flash}
        dismissFlash={tuning.dismissFlash}
        changedServerFields={tuning.changedServerFields}
        relationWarnings={tuning.relationWarnings}
        busy={store.busy}
        pendingBulkChange={tuning.pendingBulkChange}
        setPendingBulkChange={tuning.setPendingBulkChange}
        applyRestart={() => void tuning.applyRestart()}
        applyPreset={(name) => void tuning.applyPreset(name)}
        resetDefaults={tuning.resetDefaults}
      />

      <div className="tuning-grid grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto lg:grid-cols-2">
        <TuningServerSection
          t={t}
          cfg={cfg}
          disabled={tuning.configMutationsDisabled}
          numericDrafts={tuning.numericDrafts}
          onNumericChange={(key, value) => tuning.setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))}
          onNumericCommit={(field, value) => void tuning.commitNumeric(field, value)}
          updateFlash={tuning.updateFlash}
          serverTextValue={tuning.serverTextValue}
          onServerTextChange={(key, value) => tuning.setServerTextDrafts((current) => ({ ...current, [key]: value }))}
          commitServerText={(key, value) => void tuning.commitServerText(key, value)}
          projectorEditable={tuning.projectorEditable}
          serverSelectValue={tuning.serverSelectValue}
          selectServerText={tuning.selectServerText}
          applyRow={applyRow}
        />

        <TuningReasoningSection
          t={t}
          cfg={cfg}
          disabled={tuning.configMutationsDisabled}
          numericDrafts={tuning.numericDrafts}
          onNumericChange={(key, value) => tuning.setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))}
          onNumericCommit={(field, value) => void tuning.commitNumeric(field, value)}
          updateServerText={tuning.updateServerText}
          updateReasoningEffort={tuning.updateReasoningEffort}
          reasoningBudgetMessageValue={tuning.serverTextValue("reasoning_budget_message")}
          onReasoningBudgetMessageChange={(value) => tuning.setServerTextDrafts((current) => ({ ...current, reasoning_budget_message: value }))}
          onReasoningBudgetMessageCommit={(value) => void tuning.commitServerText("reasoning_budget_message", value)}
          applyRow={applyRow}
        />

        <TuningSamplingSection
          t={t}
          cfg={cfg}
          disabled={tuning.configMutationsDisabled}
          numericDrafts={tuning.numericDrafts}
          onNumericChange={(key, value) => tuning.setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))}
          onNumericCommit={(field, value) => void tuning.commitNumeric(field, value)}
          chatOptionDrafts={tuning.chatOptionDrafts}
          setChatOptionDrafts={tuning.setChatOptionDrafts}
          chatOptionSelectModes={tuning.chatOptionSelectModes}
          setChatOptionSelectModes={tuning.setChatOptionSelectModes}
          onChatOptionCommit={(field, value) => void tuning.commitChatOption(field, value)}
        />

        <TuningEscapeSection
          t={t}
          disabled={tuning.configMutationsDisabled}
          advancedError={tuning.advancedError}
          serverArgsDraft={tuning.serverArgsDraft}
          onServerArgsChange={(value) => {
            tuning.serverArgsDraftRef.current = value;
            tuning.setServerArgsDraft(value);
            tuning.setServerArgsDirty(true);
            tuning.setAdvancedError(null);
          }}
          serverArgsDirty={tuning.serverArgsDirty}
          onSaveServerArgs={() => void tuning.saveServerArgs()}
          chatOptionsDraft={tuning.chatOptionsDraft}
          onChatOptionsChange={(value) => {
            tuning.chatOptionsDraftRef.current = value;
            tuning.setChatOptionsDraft(value);
            tuning.setChatOptionsDirty(true);
            tuning.setAdvancedError(null);
          }}
          chatOptionsDirty={tuning.chatOptionsDirty}
          onSaveChatOptions={() => void tuning.saveChatOptions()}
        />
      </div>
    </div>
  );
}
