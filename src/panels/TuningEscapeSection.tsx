import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import { normalizeDisplayPathLines } from "../lifecycleUtils";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  disabled: boolean;
  advancedError: string | null;
  serverArgsDraft: string;
  onServerArgsChange: (value: string) => void;
  serverArgsDirty: boolean;
  onSaveServerArgs: () => void;
  chatOptionsDraft: string;
  onChatOptionsChange: (value: string) => void;
  chatOptionsDirty: boolean;
  onSaveChatOptions: () => void;
}

export default function TuningEscapeSection({
  t, disabled, advancedError, serverArgsDraft, onServerArgsChange, serverArgsDirty, onSaveServerArgs,
  chatOptionsDraft, onChatOptionsChange, chatOptionsDirty, onSaveChatOptions,
}: Props) {
  return (
    <section className="tuning-section tuning-section--escape min-w-0 rounded-xl border border-slate-700 app-bg-muted p-4 lg:col-span-2">
      <h2 className="app-section-title">{t("section.escape")}</h2>
      <p className="app-section-hint mb-4">{t("ui.escapeHint")}</p>
      <div className="tuning-advanced-error-slot mb-3">
        {advancedError && <div className="break-words rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">{advancedError}</div>}
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="tuning-server-args" className="text-sm font-medium text-slate-300">{t("ui.serverArgsLabel")}</label>
          <p className="app-section-hint mb-2">{t("ui.serverArgsHint")}</p>
          <textarea
            id="tuning-server-args"
            aria-label={t("ui.serverArgsLabel")}
            value={normalizeDisplayPathLines(serverArgsDraft)}
            onChange={(event) => onServerArgsChange(event.target.value)}
            disabled={disabled}
            rows={12}
            spellCheck={false}
            className="app-textarea min-h-48 font-mono text-xs"
            placeholder={'--min-p\n0.05\n--chat-template\nqwen'}
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onSaveServerArgs}
              disabled={!serverArgsDirty || disabled}
              className="app-button app-button--primary app-button--sm"
            >
              {t("extra.saveServerArguments")}
            </button>
            <span className="text-xs text-amber-400">{t("ui.restartRequiredShort")}</span>
          </div>
        </div>
        <div className="min-w-0">
          <label htmlFor="tuning-chat-options" className="text-sm font-medium text-slate-300">{t("ui.chatOptionsLabel")}</label>
          <p className="app-section-hint mb-2">{t("ui.chatOptionsHint")}</p>
          <textarea
            id="tuning-chat-options"
            aria-label={t("ui.chatOptionsLabel")}
            value={chatOptionsDraft}
            onChange={(event) => onChatOptionsChange(event.target.value)}
            disabled={disabled}
            rows={12}
            spellCheck={false}
            className="app-textarea min-h-48 font-mono text-xs"
            placeholder={'{\n  "dry_sequence_breakers": ["\\n", ":"],\n  "samplers": ["dry", "top_k", "top_p", "temperature"]\n}'}
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onSaveChatOptions}
              disabled={!chatOptionsDirty || disabled}
              className="app-button app-button--primary app-button--sm"
            >
              {t("extra.saveChatOptions")}
            </button>
            <span className="text-xs text-emerald-400">{t("ui.nextMessageShort")}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
