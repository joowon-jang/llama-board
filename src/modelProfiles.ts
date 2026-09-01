import type { AppConfig } from "./api";

export type ServerProfile = {
  id: string; name: string; backend: string; ctx_size: number; batch_size: number; ubatch_size: number; keep: number; cache_type_k: string; cache_type_v: string;
  ngl: number; n_cpu_moe: number; threads: number; parallel: number;
  request_timeout_seconds: number; sleep_idle_seconds: number; flash_attn: string; spec_type: string; spec_draft_n_max: number;
  spec_draft_n_min: number; spec_draft_p_min: number; spec_draft_p_split: number; spec_draft_ngl: string; spec_draft_device: string;
  spec_draft_model: string; reasoning: string; reasoning_format: string; reasoning_budget: number; reasoning_preserve: string;
  reasoning_budget_message: string; mmproj: string; server_args: string[];
};

export type ModelProfile = {
  id: string; modelPath: string; name: string; temperature: number; top_p: number; top_k: number; reasoning_effort: string;
  chat_options: AppConfig["chat_options"]; system_prompt: string; stop_strings: string[];
};

type StoredProfiles = { version: 2; server: ServerProfile[]; model: ModelProfile[]; activeServerId: string; activeModelIds: Record<string, string> };
const KEY = "llama-board-model-profiles";
const makeId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const sensitiveArg = /^(?:--?)(?:api[-_]?key|token|password|credential|authorization|auth)$/i;
const sanitizeArgs = (value: unknown) => {
  const args = list(value);
  const safe: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [name] = arg.split("=", 1);
    if (sensitiveArg.test(name) || /^(?:bearer|token|sk[-_])/i.test(arg)) {
      if (!arg.includes("=") && args[index + 1] && !args[index + 1].startsWith("-")) index += 1;
      continue;
    }
    safe.push(arg);
  }
  return safe;
};

export function defaultServerProfile(cfg: AppConfig): ServerProfile {
  return {
    id: "server-default", name: "기본 서버", backend: cfg.active_backend || "PATH", ctx_size: cfg.ctx_size, batch_size: cfg.batch_size, ubatch_size: cfg.ubatch_size,
    keep: cfg.keep, cache_type_k: cfg.cache_type_k, cache_type_v: cfg.cache_type_v, ngl: cfg.ngl, n_cpu_moe: cfg.n_cpu_moe,
    threads: cfg.threads, parallel: cfg.parallel, request_timeout_seconds: cfg.request_timeout_seconds, sleep_idle_seconds: cfg.sleep_idle_seconds,
    flash_attn: cfg.flash_attn || "auto", spec_type: cfg.spec_type, spec_draft_n_max: cfg.spec_draft_n_max, spec_draft_n_min: cfg.spec_draft_n_min,
    spec_draft_p_min: cfg.spec_draft_p_min, spec_draft_p_split: cfg.spec_draft_p_split, spec_draft_ngl: cfg.spec_draft_ngl,
    spec_draft_device: cfg.spec_draft_device, spec_draft_model: cfg.spec_draft_model, reasoning: cfg.reasoning, reasoning_format: cfg.reasoning_format,
    reasoning_budget: cfg.reasoning_budget, reasoning_preserve: cfg.reasoning_preserve, reasoning_budget_message: cfg.reasoning_budget_message,
    mmproj: cfg.mmproj, server_args: sanitizeArgs(cfg.server_args),
  };
}

export function defaultModelProfile(cfg: AppConfig, modelPath: string): ModelProfile {
  return { id: `model-default-${modelPath}`, modelPath, name: "기본", temperature: cfg.temperature, top_p: cfg.top_p, top_k: cfg.top_k,
    reasoning_effort: cfg.reasoning_effort, chat_options: { ...cfg.chat_options }, system_prompt: "", stop_strings: [] };
}

function read(): StoredProfiles | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<StoredProfiles> | null;
    if (!value || value.version !== 2 || !Array.isArray(value.server) || !Array.isArray(value.model)) return null;
    return { version: 2, server: value.server, model: value.model, activeServerId: text(value.activeServerId), activeModelIds: value.activeModelIds ?? {} };
  } catch { return null; }
}
function write(value: StoredProfiles) { try { window.localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* optional */ } }
function current(): StoredProfiles { return read() ?? { version: 2, server: [], model: [], activeServerId: "", activeModelIds: {} }; }
function migrateServer(value: Partial<ServerProfile>, cfg: AppConfig): ServerProfile { return { ...defaultServerProfile(cfg), ...value, server_args: list(value.server_args) }; }
function migrateModel(value: Partial<ModelProfile>, cfg: AppConfig, modelPath: string): ModelProfile { return { ...defaultModelProfile(cfg, modelPath), ...value, modelPath, chat_options: value.chat_options && typeof value.chat_options === "object" ? value.chat_options : {}, stop_strings: list(value.stop_strings) }; }

export function loadProfiles(cfg: AppConfig, modelPath: string) {
  const stored = read();
  const server = stored?.server.length ? stored.server.map((item) => migrateServer(item, cfg)) : [defaultServerProfile(cfg)];
  const model = stored?.model.filter((item) => item.modelPath === modelPath).map((item) => migrateModel(item, cfg, modelPath)) ?? [];
  const profiles = model.length ? model : [defaultModelProfile(cfg, modelPath)];
  const activeServerId = stored?.activeServerId && server.some((item) => item.id === stored.activeServerId) ? stored.activeServerId : server[0].id;
  const activeModelId = stored?.activeModelIds?.[modelPath] && profiles.some((item) => item.id === stored.activeModelIds[modelPath]) ? stored.activeModelIds[modelPath] : profiles[0].id;
  write({ version: 2, server, model: [...(stored?.model ?? []).filter((item) => item.modelPath !== modelPath), ...profiles], activeServerId, activeModelIds: { ...(stored?.activeModelIds ?? {}), [modelPath]: activeModelId } });
  return { server, model: profiles, activeServerId, activeModelId };
}
export function saveProfileSelection(activeServerId: string, modelPath: string, activeModelId: string) { const value = current(); write({ ...value, activeServerId, activeModelIds: { ...value.activeModelIds, [modelPath]: activeModelId } }); }
export function saveServerProfile(profile: ServerProfile) { const value = current(); write({ ...value, server: [...value.server.filter((item) => item.id !== profile.id), profile] }); }
export function saveModelProfile(profile: ModelProfile) { const value = current(); write({ ...value, model: [...value.model.filter((item) => item.id !== profile.id), profile] }); }
export function deleteServerProfile(profileId: string) { const value = current(); if (value.server.length <= 1) return; const server = value.server.filter((item) => item.id !== profileId); write({ ...value, server, activeServerId: value.activeServerId === profileId ? server[0].id : value.activeServerId }); }
export function deleteModelProfile(modelPath: string, profileId: string) { const value = current(); const model = value.model.filter((item) => item.modelPath !== modelPath || item.id !== profileId); const remaining = model.filter((item) => item.modelPath === modelPath); if (!remaining.length) return; write({ ...value, model, activeModelIds: { ...value.activeModelIds, [modelPath]: value.activeModelIds[modelPath] === profileId ? remaining[0].id : value.activeModelIds[modelPath] } }); }
export function duplicateServerProfile(profile: ServerProfile): ServerProfile { const copy = { ...profile, id: makeId("server"), name: `${profile.name} 복사`, server_args: [...profile.server_args] }; saveServerProfile(copy); return copy; }
export function duplicateModelProfile(profile: ModelProfile): ModelProfile { const copy = { ...profile, id: makeId("model"), name: `${profile.name} 복사`, chat_options: { ...profile.chat_options }, stop_strings: [...profile.stop_strings] }; saveModelProfile(copy); return copy; }
export function createServerProfile(cfg: AppConfig, name: string) { return { ...defaultServerProfile(cfg), id: makeId("server"), name }; }
export function createModelProfile(cfg: AppConfig, modelPath: string, name: string) { return { ...defaultModelProfile(cfg, modelPath), id: makeId("model"), name }; }

export function serverProfilePatch(profile: ServerProfile): Partial<AppConfig> {
  return { active_backend: profile.backend, ctx_size: profile.ctx_size, batch_size: profile.batch_size, ubatch_size: profile.ubatch_size, keep: profile.keep,
    cache_type_k: profile.cache_type_k, cache_type_v: profile.cache_type_v, ngl: profile.ngl, n_cpu_moe: profile.n_cpu_moe, threads: profile.threads, parallel: profile.parallel,
    request_timeout_seconds: profile.request_timeout_seconds, sleep_idle_seconds: profile.sleep_idle_seconds, flash_attn: profile.flash_attn, spec_type: profile.spec_type,
    spec_draft_n_max: profile.spec_draft_n_max, spec_draft_n_min: profile.spec_draft_n_min, spec_draft_p_min: profile.spec_draft_p_min, spec_draft_p_split: profile.spec_draft_p_split,
    spec_draft_ngl: profile.spec_draft_ngl, spec_draft_device: profile.spec_draft_device, spec_draft_model: profile.spec_draft_model, reasoning: profile.reasoning,
    reasoning_format: profile.reasoning_format, reasoning_budget: profile.reasoning_budget, reasoning_preserve: profile.reasoning_preserve,
    reasoning_budget_message: profile.reasoning_budget_message, mmproj: profile.mmproj, server_args: [...profile.server_args] };
}
export function modelProfilePatch(profile: ModelProfile): Partial<AppConfig> {
  const chat_options = { ...profile.chat_options };
  if (profile.stop_strings.length) chat_options.stop = [...profile.stop_strings];
  else delete chat_options.stop;
  return { temperature: profile.temperature, top_p: profile.top_p, top_k: profile.top_k, reasoning_effort: profile.reasoning_effort, chat_options };
}
export function getActiveModelProfile(cfg: AppConfig, modelPath: string): ModelProfile | null {
  if (!modelPath) return null;
  const loaded = loadProfiles(cfg, modelPath);
  return loaded.model.find((profile) => profile.id === loaded.activeModelId) ?? null;
}
export function profileDirtyFields(profile: ServerProfile | ModelProfile, cfg: AppConfig): string[] {
  const patch = "modelPath" in profile ? modelProfilePatch(profile) : serverProfilePatch(profile);
  return Object.keys(patch).filter((key) => JSON.stringify(patch[key as keyof typeof patch]) !== JSON.stringify(cfg[key as keyof AppConfig]));
}
export { KEY as MODEL_PROFILES_STORAGE_KEY };
