import { useMemo, useState, type ReactNode } from "react";
import type { AppStore } from "../store";
import { useI18n } from "../i18n";
import { useTuningController } from "./useTuningController";
import TuningNavigation from "./TuningNavigation";
import TuningPresetBar from "./TuningPresetBar";
import TuningServerSection from "./TuningServerSection";
import TuningReasoningSection from "./TuningReasoningSection";
import TuningSamplingSection from "./TuningSamplingSection";
import TuningEscapeSection from "./TuningEscapeSection";
import {
  MTP_FIELDS,
  SERVER_FIELDS,
  TUNING_CATEGORIES,
  TUNING_CONTENT_PANEL_ID,
  TUNING_FIELD_CATALOG,
  tuningCatalogMatches,
  type TuningCategoryId,
  type TuningSectionId,
  type TuningViewMode,
} from "./tuningFields";

type TuningSection = TuningSectionId;

const SECTION_TO_CATEGORY: Record<TuningSection, TuningCategoryId> = {
  server: "runtime",
  sampling: "sampling",
  reasoning: "reasoning",
  escape: "advanced",
};

function categoryMatchesSearch(category: (typeof TUNING_CATEGORIES)[number], query: string): boolean {
  const normalized = query.trim();
  if (!normalized) return true;
  const categoryText = `${category.label} ${category.description} ${category.keywords.join(" ")}`.toLocaleLowerCase();
  if (categoryText.includes(normalized.toLocaleLowerCase())) return true;
  return TUNING_FIELD_CATALOG
    .filter((entry) => entry.category === category.id)
    .some((entry) => tuningCatalogMatches(entry, normalized));
}

function visibleFields<T extends { category: TuningCategoryId; advancedOnly?: boolean }>(
  fields: readonly T[], category: TuningCategoryId, mode: TuningViewMode,
): T[] {
  return fields.filter((field) => field.category === category && (mode === "advanced" || !field.advancedOnly));
}

/** Tuning panel: server-side values require restart; sampling applies next chat. */
export default function TuningPanel({ store, section = "server", applyRequest = 0 }: { store: AppStore; section?: TuningSection; applyRequest?: number }) {
  const { t } = useI18n();
  const tuning = useTuningController(store, applyRequest);
  const { cfg } = tuning;
  const [mode, setMode] = useState<TuningViewMode>("quick");
  const [activeCategory, setActiveCategory] = useState<TuningCategoryId>(SECTION_TO_CATEGORY[section]);
  const [query, setQuery] = useState("");

  const visibleCategories = useMemo(
    () => TUNING_CATEGORIES.filter((category) => category.modes.includes(mode) && categoryMatchesSearch(category, query)),
    [mode, query],
  );
  const selectedCategory = visibleCategories.find((category) => category.id === activeCategory) ?? visibleCategories[0] ?? null;

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

  const renderSection = (category: (typeof TUNING_CATEGORIES)[number] | null): ReactNode => {
    const current = category?.section ?? null;
    if (current === "server") {
      const categoryId = category?.id ?? "runtime";
      const serverFields = categoryId === "speculative"
        ? visibleFields(MTP_FIELDS, categoryId, mode)
        : visibleFields(SERVER_FIELDS, categoryId, mode);
      return (
        <TuningServerSection
          t={t}
          cfg={cfg}
          disabled={tuning.configMutationsDisabled}
          numericDrafts={tuning.numericDrafts}
          onNumericChange={(key, value) => tuning.setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))}
          onNumericCommit={(field, value) => void tuning.commitNumeric(field, value)}
          updateFlash={tuning.updateFlash}
          serverTextValue={tuning.serverTextValue}
          onServerTextChange={(key, value) => tuning.setServerTextDrafts((drafts) => ({ ...drafts, [key]: value }))}
          commitServerText={(key, value) => void tuning.commitServerText(key, value)}
          projectorEditable={tuning.projectorEditable}
          serverSelectValue={tuning.serverSelectValue}
          selectServerText={tuning.selectServerText}
          showAdvanced={mode === "advanced"}
          fields={serverFields}
          showFlashAttention={categoryId === "runtime"}
          showProjector={categoryId === "multimodal"}
          showSpeculative={categoryId === "speculative"}
          showCacheTypes={categoryId === "context"}
          applyRow={applyRow}
        />
      );
    }
    if (current === "reasoning") {
      return (
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
          onReasoningBudgetMessageChange={(value) => tuning.setServerTextDrafts((currentDrafts) => ({ ...currentDrafts, reasoning_budget_message: value }))}
          onReasoningBudgetMessageCommit={(value) => void tuning.commitServerText("reasoning_budget_message", value)}
          applyRow={applyRow}
        />
      );
    }
    if (current === "sampling") {
      return (
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
          samplerChain={Array.isArray(cfg.chat_options.samplers) ? cfg.chat_options.samplers.filter((value): value is string => typeof value === "string") : []}
          onSamplerChainChange={(samplers) => void tuning.updateSamplerChain(samplers)}
          showAdvanced={mode === "advanced"}
        />
      );
    }
    if (current === "escape") {
      return (
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
      );
    }
    return null;
  };

  return (
    <div className="tuning-redesign tuning-panel relative flex h-full min-h-0 flex-col" data-tuning-mode={mode} data-tuning-category={selectedCategory?.id ?? "none"}>
      <header className="tuning-redesign__header">
        <div className="tuning-redesign__title">
          <h2>{t("section.tuning")}</h2>
          <p>{t("extra.tuningSubtitle")}</p>
        </div>
      </header>

      <div className="tuning-redesign__body">
        <TuningNavigation
          categories={visibleCategories}
          activeCategory={selectedCategory?.id ?? activeCategory}
          onSelectCategory={setActiveCategory}
          mode={mode}
          onModeChange={setMode}
          query={query}
          onQueryChange={setQuery}
        />

        <div
          className="tuning-redesign__content"
          id={TUNING_CONTENT_PANEL_ID}
          role="tabpanel"
          aria-labelledby={`tuning-mode-tab-${mode}`}
        >
          <div className="tuning-panel-scroll">
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

            {selectedCategory ? (
              <div className="tuning-category-heading">
                <h3>{t(`extra.${selectedCategory.labelKey}` as never) || selectedCategory.label}</h3>
                <p>{t(`extra.${selectedCategory.descriptionKey}` as never) || selectedCategory.description}</p>
              </div>
            ) : (
              <div className="tuning-navigation__empty" role="status">{t("extra.noSettingsMatchQuery", { query })}</div>
            )}
            {renderSection(selectedCategory)}
          </div>
        </div>
      </div>
    </div>
  );
}
