import type { AppConfig } from "../api";
import { CustomSelect } from "../components/ThemeSwitcher";
import type { ModelProfile, ServerProfile } from "../modelProfiles";
import { normalizeDisplayPath, normalizeDisplayPathLines } from "../lifecycleUtils";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import {
  chatKeys, fieldLabelClass, fieldNameClass, inputClass, modelFields, serverFields, serverPathKeys,
  type ModelKey, type ServerKey,
} from "./executionProfileFields";

type TranslateFn = (key: UnifiedKey, vars?: TranslationVars) => string;

export function ProfileActionButtons({ t, count, onRename, onDuplicate, onDeleteRequest }: {
  t: TranslateFn;
  count: number;
  onRename: () => void;
  onDuplicate: () => void;
  onDeleteRequest: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5 sm:justify-end">
      <button type="button" className="app-button app-button--secondary app-button--sm" onClick={onRename}>{t("ui.renameProfile")}</button>
      <button type="button" className="app-button app-button--secondary app-button--sm" onClick={onDuplicate}>{t("ui.duplicateProfile")}</button>
      <button type="button" className="app-button app-button--danger app-button--sm" disabled={count <= 1} onClick={onDeleteRequest}>{t("ui.deleteProfile")}</button>
    </div>
  );
}

export function ServerProfileCard({
  t, server, serverDraft, setServerDraft, serverProfiles, serverOpen, setServerOpen,
  editingName, nameDraft, setNameDraft, onRename, onSelect, onNew, onDuplicate, onDeleteRequest,
}: {
  t: TranslateFn;
  server: ServerProfile;
  serverDraft: ServerProfile;
  setServerDraft: (next: ServerProfile) => void;
  serverProfiles: ServerProfile[];
  serverOpen: boolean;
  setServerOpen: (updater: (value: boolean) => boolean) => void;
  editingName: boolean;
  nameDraft: string;
  setNameDraft: (value: string) => void;
  onRename: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onDeleteRequest: () => void;
}) {
  const updateServer = (key: ServerKey, value: string) => {
    setServerDraft({ ...serverDraft, [key]: value === "" ? "" : typeof serverDraft[key] === "number" ? Number(value) : value });
  };
  const displayServerValue = (key: ServerKey): string => {
    const value = String(serverDraft[key] ?? "");
    return serverPathKeys.has(key) ? normalizeDisplayPath(value) : value;
  };

  return (
    <div className="min-w-0 rounded-lg border p-3" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <button type="button" className="cursor-pointer text-left text-sm font-semibold transition-colors hover:opacity-80" style={{ color: "var(--board-ink)" }} onClick={() => setServerOpen((value) => !value)}>
          {t("ui.serverProfile")} {serverOpen ? "⌃" : "⌄"}
        </button>
        <button type="button" className="app-button app-button--primary app-button--sm" onClick={onNew}>{t("ui.newProfile")}</button>
      </div>

      <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]" data-testid="server-profile-picker">
        <CustomSelect
          value={server.id}
          options={serverProfiles.map((item) => ({ value: item.id, label: item.name }))}
          onChange={onSelect}
          ariaLabel={t("ui.selectServerProfile")}
          size="sm"
          className="w-full"
        />
        <ProfileActionButtons t={t} count={serverProfiles.length} onRename={onRename} onDuplicate={onDuplicate} onDeleteRequest={onDeleteRequest} />
      </div>

      {editingName && (
        <div className="mt-2 flex min-w-0 flex-wrap gap-2">
          <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className={`${inputClass} mt-0 min-w-0 flex-1`} aria-label={t("ui.serverProfileName")} />
          <button type="button" className="app-button app-button--primary app-button--sm shrink-0" onClick={onRename}>{t("ui.saveProfile")}</button>
        </div>
      )}

      {serverOpen && (
        <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
          {serverFields.map(([key, label, type]) => (
            <label key={key} className={fieldLabelClass}>
              <span className={fieldNameClass}>{t(`ui.${label}`)}</span>
              <input type={type} value={displayServerValue(key)} onChange={(event) => updateServer(key, event.target.value)} className={`${inputClass} mt-0`} />
            </label>
          ))}
          <label className={`${fieldLabelClass} sm:col-span-2`}>
            <span className={fieldNameClass}>{t("ui.serverArgs")}</span>
            <textarea
              value={normalizeDisplayPathLines(serverDraft.server_args.join("\n"))}
              onChange={(event) => setServerDraft({ ...serverDraft, server_args: event.target.value.split("\n").filter(Boolean) })}
              className={`${inputClass} mt-0 min-h-20`}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function ModelProfileCard({
  t, model, modelDraft, setModelDraft, modelProfiles, modelOpen, setModelOpen,
  editingName, nameDraft, setNameDraft, onRename, onSelect, onNew, onDuplicate, onDeleteRequest,
  jsonError, setJsonError,
}: {
  t: TranslateFn;
  model: ModelProfile;
  modelDraft: ModelProfile;
  setModelDraft: (next: ModelProfile) => void;
  modelProfiles: ModelProfile[];
  modelOpen: boolean;
  setModelOpen: (updater: (value: boolean) => boolean) => void;
  editingName: boolean;
  nameDraft: string;
  setNameDraft: (value: string) => void;
  onRename: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onDeleteRequest: () => void;
  jsonError: string | null;
  setJsonError: (value: string | null) => void;
}) {
  const updateModel = (key: ModelKey, value: string) => {
    setModelDraft({ ...modelDraft, [key]: value === "" ? "" : typeof modelDraft[key] === "number" ? Number(value) : value });
  };

  return (
    <div className="min-w-0 rounded-lg border p-3" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <button type="button" className="cursor-pointer text-left text-sm font-semibold transition-colors hover:opacity-80" style={{ color: "var(--board-ink)" }} onClick={() => setModelOpen((value) => !value)}>
          {t("ui.modelTuningProfile")} {modelOpen ? "⌃" : "⌄"}
        </button>
        <button type="button" className="app-button app-button--primary app-button--sm" onClick={onNew}>{t("ui.newProfile")}</button>
      </div>

      <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]" data-testid="model-profile-picker">
        <CustomSelect
          value={model.id}
          options={modelProfiles.map((item) => ({ value: item.id, label: item.name }))}
          onChange={onSelect}
          ariaLabel={t("ui.selectModelProfile")}
          className="w-full"
        />
        <ProfileActionButtons t={t} count={modelProfiles.length} onRename={onRename} onDuplicate={onDuplicate} onDeleteRequest={onDeleteRequest} />
      </div>

      {editingName && (
        <div className="mt-2 flex min-w-0 flex-wrap gap-2">
          <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className={`${inputClass} mt-0 min-w-0 flex-1`} aria-label={t("ui.modelProfileName")} />
          <button type="button" className="app-button app-button--primary app-button--sm shrink-0" onClick={onRename}>{t("ui.saveProfile")}</button>
        </div>
      )}

      {modelOpen && (
        <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
          {modelFields.map(([key, label, type]) => (
            <label key={key} className={fieldLabelClass}>
              <span className={fieldNameClass}>{t(`ui.${label}`)}</span>
              <input type={type} value={String(modelDraft[key] ?? "")} onChange={(event) => updateModel(key, event.target.value)} className={`${inputClass} mt-0`} />
            </label>
          ))}
          <label className={`${fieldLabelClass} sm:col-span-2`} data-testid="model-system-prompt-field">
            <span className={fieldNameClass}>{t("ui.profileSystemPrompt")}</span>
            <textarea
              value={modelDraft.system_prompt}
              onChange={(event) => setModelDraft({ ...modelDraft, system_prompt: event.target.value })}
              className={`${inputClass} mt-0 min-h-24`}
            />
          </label>
          <div className="grid min-w-0 gap-2 sm:col-span-2 sm:grid-cols-2">
            {chatKeys.map((key) => (
              <label key={key} className={fieldLabelClass}>
                <span className={fieldNameClass}>{key}</span>
                <input
                  type="number"
                  value={String(modelDraft.chat_options[key] ?? "")}
                  onChange={(event) => setModelDraft({
                    ...modelDraft,
                    chat_options: { ...modelDraft.chat_options, [key]: Number(event.target.value) },
                  })}
                  className={`${inputClass} mt-0`}
                />
              </label>
            ))}
          </div>
          <label className={`${fieldLabelClass} sm:col-span-2`}>
            <span className={fieldNameClass}>{t("ui.profileStopStrings")}</span>
            <textarea
              value={modelDraft.stop_strings.join("\n")}
              onChange={(event) => setModelDraft({ ...modelDraft, stop_strings: event.target.value.split("\n") })}
              className={`${inputClass} mt-0 min-h-20`}
            />
          </label>
          <label className={`${fieldLabelClass} sm:col-span-2`}>
            <span className={fieldNameClass}>{t("ui.profileChatOptionsJson")}</span>
            <textarea
              value={JSON.stringify(modelDraft.chat_options, null, 2)}
              onChange={(event) => {
                try {
                  const parsed = JSON.parse(event.target.value) as AppConfig["chat_options"];
                  setModelDraft({ ...modelDraft, chat_options: parsed });
                  setJsonError(null);
                } catch {
                  setJsonError(t("ui.profileJsonInvalid"));
                }
              }}
              className={`${inputClass} mt-0 min-h-28 font-mono`}
            />
            {jsonError && <span className="mt-1 block text-xs text-red-300" role="alert">{jsonError}</span>}
          </label>
        </div>
      )}
    </div>
  );
}
