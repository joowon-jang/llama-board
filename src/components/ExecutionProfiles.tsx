import { useEffect, useMemo, useState } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import ConfirmDialog from "./ConfirmDialog";
import { CustomSelect } from "./ThemeSwitcher";
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
import { normalizeDisplayPath, normalizeDisplayPathLines } from "../lifecycleUtils";

type Props = { store: AppStore; modelPath: string };
type ServerKey = Exclude<keyof ServerProfile, "id" | "name" | "server_args">;
type ModelKey = Exclude<keyof ModelProfile, "id" | "modelPath" | "name" | "chat_options" | "stop_strings">;

const serverFields: Array<[ServerKey, string, "number" | "text"]> = [
  ["backend", "Backend", "text"],
  ["ctx_size", "Context size", "number"],
  ["ngl", "GPU layers", "number"],
  ["n_cpu_moe", "CPU MoE", "number"],
  ["threads", "Threads", "number"],
  ["parallel", "Server slots", "number"],
  ["request_timeout_seconds", "Request timeout (s)", "number"],
  ["sleep_idle_seconds", "Sleep after idle (s)", "number"],
  ["flash_attn", "Flash attention", "text"],
  ["spec_type", "Speculative type", "text"],
  ["spec_draft_n_max", "Draft max tokens", "number"],
  ["spec_draft_n_min", "Draft min tokens", "number"],
  ["spec_draft_p_min", "Draft min probability", "number"],
  ["spec_draft_p_split", "Draft split probability", "number"],
  ["spec_draft_ngl", "Draft GPU layers", "text"],
  ["spec_draft_device", "Draft device", "text"],
  ["spec_draft_model", "Draft model", "text"],
  ["reasoning", "Reasoning", "text"],
  ["reasoning_format", "Reasoning format", "text"],
  ["reasoning_budget", "Reasoning budget", "number"],
  ["reasoning_preserve", "Reasoning preserve", "text"],
  ["reasoning_budget_message", "Reasoning budget message", "text"],
  ["mmproj", "Vision projector path", "text"],
];

const modelFields: Array<[ModelKey, string, "number" | "text"]> = [
  ["temperature", "Temperature", "number"],
  ["top_p", "Top P", "number"],
  ["top_k", "Top K", "number"],
  ["reasoning_effort", "Reasoning effort", "text"],
];

const chatKeys = [
  "min_p",
  "top_n_sigma",
  "typical_p",
  "xtc_probability",
  "xtc_threshold",
  "dynatemp_range",
  "dynatemp_exponent",
  "repeat_last_n",
  "repeat_penalty",
  "presence_penalty",
  "frequency_penalty",
  "dry_multiplier",
  "dry_base",
  "dry_allowed_length",
  "dry_penalty_last_n",
  "mirostat",
  "mirostat_lr",
  "mirostat_ent",
  "seed",
  "max_tokens",
  "n_probs",
  "min_keep",
  "t_max_predict_ms",
  "id_slot",
] as const;

const inputClass = "mt-1 min-w-0 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";
const fieldLabelClass = "min-w-0 text-xs text-slate-400";
const fieldNameClass = "mb-1 block break-words";
const serverPathKeys = new Set<ServerKey>(["spec_draft_model", "mmproj"]);

export default function ExecutionProfiles({ store, modelPath }: Props) {
  const cfg = store.cfg;
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

  const updateServer = (key: ServerKey, value: string) => {
    setServerDraft((current) => current
      ? { ...current, [key]: value === "" ? "" : typeof current[key] === "number" ? Number(value) : value }
      : current);
  };
  const updateModel = (key: ModelKey, value: string) => {
    setModelDraft((current) => current
      ? { ...current, [key]: value === "" ? "" : typeof current[key] === "number" ? Number(value) : value }
      : current);
  };
  const displayServerValue = (key: ServerKey): string => {
    const value = String(serverDraft[key] ?? "");
    return serverPathKeys.has(key) ? normalizeDisplayPath(value) : value;
  };

  const saveServer = () => {
    setServerProfiles((items) => items.map((item) => item.id === server.id ? serverDraft : item));
    saveServerProfile(serverDraft);
    setNotice("서버 프로필을 저장했습니다.");
  };
  const saveModel = () => {
    setModelProfiles((items) => items.map((item) => item.id === model.id ? modelDraft : item));
    saveModelProfile(modelDraft);
    setNotice("모델 프로필을 저장했습니다.");
  };
  const newServer = () => {
    const next = createServerProfile(cfg, `서버 프로필 ${serverProfiles.length + 1}`);
    setServerProfiles((items) => [...items, next]);
    saveServerProfile(next);
    setServerId(next.id);
    saveProfileSelection(next.id, modelPath, model.id);
  };
  const newModel = () => {
    const next = createModelProfile(cfg, modelPath, `모델 프로필 ${modelProfiles.length + 1}`);
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
  };
  const duplicateModelActive = () => {
    const next = duplicateModelProfile(model);
    setModelProfiles((items) => [...items, next]);
    setModelId(next.id);
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
      setNotice("프로필을 적용했습니다. 서버 설정은 재시작 후, 샘플링 설정은 다음 요청부터 적용됩니다.");
    } catch (error) {
      setNotice(`프로필 적용 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const editName = (kind: "server" | "model") => {
    setEditingName(kind);
    setNameDraft(kind === "server" ? server.name : model.name);
  };
  const actionButtons = (kind: "server" | "model") => (
    <div className="flex min-w-0 flex-wrap gap-1.5 sm:justify-end">
      <button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => editName(kind)}>이름 변경</button>
      <button type="button" className="app-button app-button--secondary app-button--sm" onClick={kind === "server" ? duplicateServerActive : duplicateModelActive}>복제</button>
      <button
        type="button"
        className="app-button app-button--danger app-button--sm"
        disabled={(kind === "server" ? serverProfiles.length : modelProfiles.length) <= 1}
        onClick={() => setConfirm(kind)}
      >
        삭제
      </button>
    </div>
  );

  return (
    <section className="execution-profiles-section mt-3 min-w-0 rounded-none border-t border-indigo-700/60 pt-3 sm:pt-4" data-testid="execution-profiles-section" aria-labelledby="execution-profiles-heading">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="execution-profiles-heading" className="text-sm font-semibold text-slate-100">실행 프로필</h2>
          <p className="mt-0.5 text-xs text-slate-400">서버 재시작 설정과 모델별 튜닝을 한 곳에서 관리합니다.</p>
        </div>
        <span className="shrink-0 text-xs text-slate-400">{serverDirty || modelDirty ? "변경사항 있음" : "적용됨"}</span>
      </div>

      <div className="execution-profiles-grid mt-3 grid min-w-0 items-start gap-3 xl:grid-cols-2" data-testid="execution-profiles-grid">
        <div className="min-w-0 rounded-lg border border-slate-700 bg-slate-900/30 p-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <button type="button" className="cursor-pointer text-left text-sm font-semibold text-slate-200 transition-colors hover:text-indigo-300" onClick={() => setServerOpen((value) => !value)}>
              서버 프로필 {serverOpen ? "⌃" : "⌄"}
            </button>
            <button type="button" className="app-button app-button--primary app-button--sm" onClick={newServer}>새 프로필</button>
          </div>

          <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]" data-testid="server-profile-picker">
            <CustomSelect
              value={server.id}
              options={serverProfiles.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(nextId) => {
                setServerId(nextId);
                saveProfileSelection(nextId, modelPath, model.id);
              }}
              ariaLabel="서버 프로필 선택"
              size="sm"
              className="w-full"
            />
            {actionButtons("server")}
          </div>

          {editingName === "server" && (
            <div className="mt-2 flex min-w-0 flex-wrap gap-2">
              <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className={`${inputClass} mt-0 min-w-0 flex-1`} aria-label="서버 프로필 이름" />
              <button type="button" className="app-button app-button--primary app-button--sm shrink-0" onClick={() => rename("server")}>저장</button>
            </div>
          )}

          {serverOpen && (
            <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
              {serverFields.map(([key, label, type]) => (
                <label key={key} className={fieldLabelClass}>
                  <span className={fieldNameClass}>{label}</span>
                  <input type={type} value={displayServerValue(key)} onChange={(event) => updateServer(key, event.target.value)} className={`${inputClass} mt-0`} />
                </label>
              ))}
              <label className={`${fieldLabelClass} sm:col-span-2`}>
                <span className={fieldNameClass}>Server args</span>
                <textarea
                  value={normalizeDisplayPathLines(serverDraft.server_args.join("\n"))}
                  onChange={(event) => setServerDraft({ ...serverDraft, server_args: event.target.value.split("\n").filter(Boolean) })}
                  className={`${inputClass} mt-0 min-h-20`}
                />
              </label>
            </div>
          )}
        </div>

        <div className="min-w-0 rounded-lg border border-slate-700 bg-slate-900/30 p-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <button type="button" className="cursor-pointer text-left text-sm font-semibold text-slate-200 transition-colors hover:text-indigo-300" onClick={() => setModelOpen((value) => !value)}>
              모델 튜닝 프로필 {modelOpen ? "⌃" : "⌄"}
            </button>
            <button type="button" className="app-button app-button--primary app-button--sm" onClick={newModel}>새 프로필</button>
          </div>

          <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]" data-testid="model-profile-picker">
            <CustomSelect
              value={model.id}
              options={modelProfiles.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(nextId) => {
                setModelId(nextId);
                saveProfileSelection(server.id, modelPath, nextId);
              }}
              ariaLabel="모델 프로필 선택"
              className="w-full"
            />
            {actionButtons("model")}
          </div>

          {editingName === "model" && (
            <div className="mt-2 flex min-w-0 flex-wrap gap-2">
              <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className={`${inputClass} mt-0 min-w-0 flex-1`} aria-label="모델 프로필 이름" />
              <button type="button" className="app-button app-button--primary app-button--sm shrink-0" onClick={() => rename("model")}>저장</button>
            </div>
          )}

          {modelOpen && (
            <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
              {modelFields.map(([key, label, type]) => (
                <label key={key} className={fieldLabelClass}>
                  <span className={fieldNameClass}>{label}</span>
                  <input type={type} value={String(modelDraft[key] ?? "")} onChange={(event) => updateModel(key, event.target.value)} className={`${inputClass} mt-0`} />
                </label>
              ))}
              <label className={`${fieldLabelClass} sm:col-span-2`} data-testid="model-system-prompt-field">
                <span className={fieldNameClass}>System prompt</span>
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
                <span className={fieldNameClass}>Stop strings</span>
                <textarea
                  value={modelDraft.stop_strings.join("\n")}
                  onChange={(event) => setModelDraft({ ...modelDraft, stop_strings: event.target.value.split("\n") })}
                  className={`${inputClass} mt-0 min-h-20`}
                />
              </label>
              <label className={`${fieldLabelClass} sm:col-span-2`}>
                <span className={fieldNameClass}>Chat options JSON</span>
                <textarea
                  value={JSON.stringify(modelDraft.chat_options, null, 2)}
                  onChange={(event) => {
                    try {
                      const parsed = JSON.parse(event.target.value) as AppConfig["chat_options"];
                      setModelDraft({ ...modelDraft, chat_options: parsed });
                      setJsonError(null);
                    } catch {
                      setJsonError("JSON 형식이 올바르지 않습니다.");
                    }
                  }}
                  className={`${inputClass} mt-0 min-h-28 font-mono`}
                />
                {jsonError && <span className="mt-1 block text-xs text-red-300" role="alert">{jsonError}</span>}
              </label>
            </div>
          )}
        </div>
      </div>

      {(serverDirty || modelDirty) && (
        <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-indigo-900/60 pt-3">
          <span className="text-xs text-amber-200">{serverDirty ? "서버 설정 변경 · 재시작 필요" : "모델 설정 변경 · 다음 요청부터 적용"}</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="app-button app-button--secondary" onClick={() => {
              setServerDraft(structuredClone(server));
              setModelDraft(structuredClone(model));
            }}>
              되돌리기
            </button>
            <button type="button" className="app-button app-button--primary" onClick={() => void apply()}>적용</button>
          </div>
        </div>
      )}

      {notice && <div className="mt-2 text-xs text-slate-300" role="status">{notice}</div>}
      <ConfirmDialog
        open={confirm !== null}
        title="프로필 삭제"
        description="선택한 프로필을 삭제하시겠습니까? 마지막 프로필은 삭제할 수 없습니다."
        confirmLabel="삭제"
        onConfirm={confirmDelete}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
