import { useEffect, useMemo, useState } from "react";
import type { AppStore } from "../store";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  createModelProfile,
  createServerProfile,
  deleteModelProfile,
  deleteServerProfile,
  duplicateModelProfile,
  duplicateServerProfile,
  loadProfiles,
  modelProfilePatch,
  saveModelProfile,
  saveProfileSelection,
  saveServerProfile,
  serverProfilePatch,
  type ModelProfile,
  type ServerProfile,
} from "../modelProfiles";
import { useI18n } from "../i18n";
import { ModelProfileCard, ServerProfileCard } from "./ExecutionProfileCards";

type Props = { store: AppStore; modelPath: string };

export default function ExecutionProfiles({ store, modelPath }: Props) {
  const cfg = store.cfg;
  const { t } = useI18n();
  // Profile data is synchronous local state. Hydrate it in the initial render
  // so the profile section has its final geometry before the model list paints.
  const [initialProfiles] = useState(() => cfg && modelPath ? loadProfiles(cfg, modelPath) : null);
  const initialServer = initialProfiles?.server.find((item) => item.id === initialProfiles.activeServerId) ?? initialProfiles?.server[0];
  const initialModel = initialProfiles?.model.find((item) => item.id === initialProfiles.activeModelId) ?? initialProfiles?.model[0];
  const [serverProfiles, setServerProfiles] = useState<ServerProfile[]>(() => initialProfiles?.server ?? []);
  const [modelProfiles, setModelProfiles] = useState<ModelProfile[]>(() => initialProfiles?.model ?? []);
  const [serverId, setServerId] = useState(() => initialProfiles?.activeServerId ?? "");
  const [modelId, setModelId] = useState(() => initialProfiles?.activeModelId ?? "");
  const [serverDraft, setServerDraft] = useState<ServerProfile | null>(() => initialServer ? structuredClone(initialServer) : null);
  const [modelDraft, setModelDraft] = useState<ModelProfile | null>(() => initialModel ? structuredClone(initialModel) : null);
  const [serverOpen, setServerOpen] = useState(true);
  const [modelOpen, setModelOpen] = useState(true);
  const [editingName, setEditingName] = useState<"server" | "model" | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"server" | "model" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!cfg || !modelPath) return;
    const loaded = loadProfiles(cfg, modelPath);
    setServerProfiles(loaded.server);
    setModelProfiles(loaded.model);
    setServerId(loaded.activeServerId);
    setModelId(loaded.activeModelId);
  }, [cfg, modelPath]);

  const server = serverProfiles.find((item) => item.id === serverId) ?? serverProfiles[0];
  const model = modelProfiles.find((item) => item.id === modelId) ?? modelProfiles[0];

  useEffect(() => {
    setServerDraft(structuredClone(server));
  }, [server]);

  useEffect(() => {
    setModelDraft(structuredClone(model));
  }, [model]);

  const serverDirty = useMemo(
    () => JSON.stringify(serverDraft) !== JSON.stringify(server),
    [serverDraft, server],
  );
  const modelDirty = useMemo(
    () => JSON.stringify(modelDraft) !== JSON.stringify(model),
    [modelDraft, model],
  );

  if (!cfg || !server || !model || !serverDraft || !modelDraft) return null;

  const saveServer = () => {
    setServerProfiles((items) => items.map((item) => item.id === server.id ? serverDraft : item));
    saveServerProfile(serverDraft);
    setNotice(t("ui.profileServerSaved"));
  };
  const saveModel = () => {
    setModelProfiles((items) => items.map((item) => item.id === model.id ? modelDraft : item));
    saveModelProfile(modelDraft);
    setNotice(t("ui.profileModelSaved"));
  };
  const newServer = () => {
    const next = createServerProfile(cfg, t("ui.profileServerName", { count: serverProfiles.length + 1 }));
    setServerProfiles((items) => [...items, next]);
    saveServerProfile(next);
    setServerId(next.id);
    saveProfileSelection(next.id, modelPath, model.id);
  };
  const newModel = () => {
    const next = createModelProfile(cfg, modelPath, t("ui.profileModelName", { count: modelProfiles.length + 1 }));
    setModelProfiles((items) => [...items, next]);
    saveModelProfile(next);
    setModelId(next.id);
    saveProfileSelection(server.id, modelPath, next.id);
  };
  const rename = (kind: "server" | "model") => {
    const value = nameDraft.trim();
    if (!value) return;
    if (kind === "server") {
      const next = { ...server, name: value };
      setServerProfiles((items) => items.map((item) => item.id === server.id ? next : item));
      saveServerProfile(next);
    } else {
      const next = { ...model, name: value };
      setModelProfiles((items) => items.map((item) => item.id === model.id ? next : item));
      saveModelProfile(next);
    }
    setEditingName(null);
  };
  const duplicateServerActive = () => {
    const next = duplicateServerProfile(server);
    setServerProfiles((items) => [...items, next]);
    setServerId(next.id);
    saveProfileSelection(next.id, modelPath, model.id);
  };
  const duplicateModelActive = () => {
    const next = duplicateModelProfile(model);
    setModelProfiles((items) => [...items, next]);
    setModelId(next.id);
    saveProfileSelection(server.id, modelPath, next.id);
  };
  const confirmDelete = () => {
    if (confirm === "server" && serverProfiles.length > 1) {
      deleteServerProfile(server.id);
      const next = serverProfiles.filter((item) => item.id !== server.id);
      setServerProfiles(next);
      setServerId(next[0].id);
    }
    if (confirm === "model" && modelProfiles.length > 1) {
      deleteModelProfile(modelPath, model.id);
      const next = modelProfiles.filter((item) => item.id !== model.id);
      setModelProfiles(next);
      setModelId(next[0].id);
    }
    setConfirm(null);
  };
  const apply = async () => {
    try {
      await store.updateConfig({ ...serverProfilePatch(serverDraft), ...modelProfilePatch(modelDraft) });
      saveServer();
      saveModel();
      setNotice(t("ui.profileAppliedNotice"));
    } catch (error) {
      setNotice(t("ui.profileApplyFailedNotice", { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const editName = (kind: "server" | "model") => {
    setEditingName(kind);
    setNameDraft(kind === "server" ? server.name : model.name);
  };

  return (
    <section className="execution-profiles-section mt-3 min-w-0 rounded-none border-t border-indigo-700 pt-3 sm:pt-4" data-testid="execution-profiles-section" aria-labelledby="execution-profiles-heading">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="execution-profiles-heading" className="text-sm font-semibold text-slate-100">{t("ui.executionProfiles")}</h2>
          <p className="mt-0.5 text-xs text-slate-400">{t("ui.executionProfilesHint")}</p>
        </div>
        <span className="shrink-0 text-xs text-slate-400">{serverDirty || modelDirty ? t("ui.profileChanged") : t("ui.profileApplied")}</span>
      </div>

      <div className="execution-profiles-grid mt-3 grid min-w-0 items-start gap-3 xl:grid-cols-2" data-testid="execution-profiles-grid">
        <ServerProfileCard
          t={t}
          server={server}
          serverDraft={serverDraft}
          setServerDraft={setServerDraft}
          serverProfiles={serverProfiles}
          serverOpen={serverOpen}
          setServerOpen={setServerOpen}
          editingName={editingName === "server"}
          nameDraft={nameDraft}
          setNameDraft={setNameDraft}
          onRename={() => (editingName === "server" ? rename("server") : editName("server"))}
          onSelect={(nextId) => { setServerId(nextId); saveProfileSelection(nextId, modelPath, model.id); }}
          onNew={newServer}
          onDuplicate={duplicateServerActive}
          onDeleteRequest={() => setConfirm("server")}
        />

        <ModelProfileCard
          t={t}
          model={model}
          modelDraft={modelDraft}
          setModelDraft={setModelDraft}
          modelProfiles={modelProfiles}
          modelOpen={modelOpen}
          setModelOpen={setModelOpen}
          editingName={editingName === "model"}
          nameDraft={nameDraft}
          setNameDraft={setNameDraft}
          onRename={() => (editingName === "model" ? rename("model") : editName("model"))}
          onSelect={(nextId) => { setModelId(nextId); saveProfileSelection(server.id, modelPath, nextId); }}
          onNew={newModel}
          onDuplicate={duplicateModelActive}
          onDeleteRequest={() => setConfirm("model")}
          jsonError={jsonError}
          setJsonError={setJsonError}
        />
      </div>

      {(serverDirty || modelDirty) && (
        <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t app-border-accent pt-3">
          <span className="text-xs text-amber-200">{serverDirty ? t("ui.profileServerSettingsChanged") : t("ui.profileModelSettingsChanged")}</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="app-button app-button--secondary" onClick={() => {
              setServerDraft(structuredClone(server));
              setModelDraft(structuredClone(model));
            }}>
              {t("ui.undoProfileChanges")}
            </button>
            <button type="button" className="app-button app-button--primary" onClick={() => void apply()}>{t("ui.applyProfiles")}</button>
          </div>
        </div>
      )}

      {notice && <div className="mt-2 text-xs text-slate-300" role="status">{notice}</div>}
      <ConfirmDialog
        open={confirm !== null}
        title={t("ui.profileDeleteTitle")}
        description={t("ui.profileDeleteBody")}
        confirmLabel={t("ui.deleteProfile")}
        onConfirm={confirmDelete}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
