import type { AppConfig, LoraAdapterConfig } from "./api";
import type { JsonObject } from "./panels/tuningValidation";

export const PROJECTS_KEY = "llama-board.projects.v1";
export const ACTIVE_PROJECT_KEY = "llama-board.active-project.v1";
export const PROJECTS_CHANGED_EVENT = "llama-board-projects-changed";

export type ProjectConfigKey =
  | "active_model"
  | "active_backend"
  | "active_build"
  | "mmproj"
  | "ctx_size"
  | "batch_size"
  | "ubatch_size"
  | "keep"
  | "cache_type_k"
  | "cache_type_v"
  | "ngl"
  | "threads"
  | "parallel"
  | "request_timeout_seconds"
  | "sleep_idle_seconds"
  | "flash_attn"
  | "n_cpu_moe"
  | "temperature"
  | "top_p"
  | "top_k"
  | "spec_type"
  | "spec_draft_n_max"
  | "spec_draft_n_min"
  | "spec_draft_p_min"
  | "spec_draft_p_split"
  | "spec_draft_ngl"
  | "spec_draft_device"
  | "spec_draft_model"
  | "reasoning"
  | "reasoning_format"
  | "reasoning_effort"
  | "reasoning_budget"
  | "reasoning_budget_message"
  | "reasoning_preserve"
  | "server_args"
  | "chat_options"
  | "lora_adapters";

export type ProjectConfig = Pick<AppConfig, ProjectConfigKey>;

export interface ProjectDocument {
  name: string;
  path: string;
}

export interface ProjectPreset {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  config: ProjectConfig;
  documentBindings: ProjectDocument[];
  toolIds: string[];
  createdAt: number;
  updatedAt: number;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const PROJECT_CACHE_TYPES = new Set(["f16", "f32", "bf16", "q8_0", "q5_0", "q5_1", "q4_0", "q4_1"]);

function boolArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 128) : [];
}

function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function loraAdapters(value: unknown): LoraAdapterConfig[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<LoraAdapterConfig> => !!item && typeof item === "object")
    .map((item) => ({
      path: stringValue(item.path).slice(0, 32_768),
      scale: Math.max(0, Math.min(4, numberValue(item.scale, 1))),
      enabled: item.enabled !== false,
    }))
    .filter((item) => item.path.toLowerCase().endsWith(".gguf"))
    .slice(0, 32);
}

function normalizeConfig(value: unknown): ProjectConfig {
  const source = value && typeof value === "object" ? value as Partial<ProjectConfig> : {};
  const batch_size = Math.min(131072, Math.max(1, Math.trunc(numberValue(source.batch_size, 2048))));
  const ubatch_size = Math.min(batch_size, Math.max(1, Math.trunc(numberValue(source.ubatch_size, 512))));
  const keep = Math.min(131072, Math.max(0, Math.trunc(numberValue(source.keep, 0))));
  const cache_type_k = typeof source.cache_type_k === "string" && PROJECT_CACHE_TYPES.has(source.cache_type_k) ? source.cache_type_k : "f16";
  const cache_type_v = typeof source.cache_type_v === "string" && PROJECT_CACHE_TYPES.has(source.cache_type_v) ? source.cache_type_v : "f16";
  return {
    active_model: stringValue(source.active_model),
    active_backend: stringValue(source.active_backend),
    active_build: stringValue(source.active_build),
    mmproj: stringValue(source.mmproj),
    ctx_size: numberValue(source.ctx_size, 4096),
    batch_size,
    ubatch_size,
    keep,
    cache_type_k,
    cache_type_v,
    ngl: numberValue(source.ngl, 0),
    threads: numberValue(source.threads, 0),
    parallel: numberValue(source.parallel, 0),
    request_timeout_seconds: numberValue(source.request_timeout_seconds, 3600),
    sleep_idle_seconds: numberValue(source.sleep_idle_seconds, -1),
    flash_attn: stringValue(source.flash_attn, "auto"),
    n_cpu_moe: numberValue(source.n_cpu_moe, 0),
    temperature: numberValue(source.temperature, 0.8),
    top_p: numberValue(source.top_p, 0.95),
    top_k: numberValue(source.top_k, 40),
    spec_type: stringValue(source.spec_type, "none"),
    spec_draft_n_max: numberValue(source.spec_draft_n_max, 3),
    spec_draft_n_min: numberValue(source.spec_draft_n_min, 0),
    spec_draft_p_min: numberValue(source.spec_draft_p_min, 0),
    spec_draft_p_split: numberValue(source.spec_draft_p_split, 0.1),
    spec_draft_ngl: stringValue(source.spec_draft_ngl, "auto"),
    spec_draft_device: stringValue(source.spec_draft_device),
    spec_draft_model: stringValue(source.spec_draft_model),
    reasoning: stringValue(source.reasoning, "auto"),
    reasoning_format: stringValue(source.reasoning_format, "auto"),
    reasoning_effort: stringValue(source.reasoning_effort, "default"),
    reasoning_budget: numberValue(source.reasoning_budget, -1),
    reasoning_budget_message: stringValue(source.reasoning_budget_message),
    reasoning_preserve: stringValue(source.reasoning_preserve, "auto"),
    server_args: Array.isArray(source.server_args) ? source.server_args.filter((item): item is string => typeof item === "string").slice(0, 512) : [],
    chat_options: jsonObject(source.chat_options),
    lora_adapters: loraAdapters(source.lora_adapters),
  };
}

function normalizeProject(value: unknown): ProjectPreset | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<ProjectPreset>;
  const name = stringValue(source.name).trim();
  if (!name) return null;
  const now = Date.now();
  const documents = Array.isArray(source.documentBindings)
    ? source.documentBindings
      .filter((item): item is ProjectDocument => !!item && typeof item === "object" && typeof (item as ProjectDocument).name === "string" && typeof (item as ProjectDocument).path === "string")
      .slice(0, 16)
      .map((item) => ({ name: item.name.slice(0, 256), path: item.path.slice(0, 32_768) }))
    : [];
  return {
    id: stringValue(source.id, `project-${now.toString(36)}`),
    name: name.slice(0, 128),
    description: stringValue(source.description).slice(0, 512),
    systemPrompt: stringValue(source.systemPrompt, "You are a helpful assistant.").slice(0, 32_768),
    config: normalizeConfig(source.config),
    documentBindings: documents,
    toolIds: boolArray(source.toolIds),
    createdAt: numberValue(source.createdAt, now),
    updatedAt: numberValue(source.updatedAt, now),
  };
}

export function readProjects(store: Storage | null = storage()): ProjectPreset[] {
  if (!store) return [];
  try {
    const value = JSON.parse(store.getItem(PROJECTS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.map(normalizeProject).filter((item): item is ProjectPreset => item !== null).slice(0, 100);
  } catch {
    return [];
  }
}

export function writeProjects(projects: ProjectPreset[], store: Storage | null = storage()): void {
  if (!store) return;
  try {
    store.setItem(PROJECTS_KEY, JSON.stringify(projects.slice(0, 100)));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  } catch {
    // Storage quota or restricted WebView must not break the chat client.
  }
}

export function activeProjectId(store: Storage | null = storage()): string | null {
  if (!store) return null;
  const value = store.getItem(ACTIVE_PROJECT_KEY);
  return value?.trim() || null;
}

export function setActiveProjectId(id: string | null, store: Storage | null = storage()): void {
  if (!store) return;
  try {
    if (id) store.setItem(ACTIVE_PROJECT_KEY, id);
    else store.removeItem(ACTIVE_PROJECT_KEY);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  } catch {
    // best effort only
  }
}

export function projectFromConfig(
  name: string,
  systemPrompt: string,
  config: AppConfig,
  documentBindings: ProjectDocument[] = [],
  toolIds: string[] = [],
  description = "",
  now = Date.now(),
): ProjectPreset {
  const project = normalizeProject({
    id: `project-${now.toString(36)}`,
    name,
    description,
    systemPrompt,
    config,
    documentBindings,
    toolIds,
    createdAt: now,
    updatedAt: now,
  });
  if (!project) throw new Error("A project name is required.");
  return project;
}

export function upsertProject(project: ProjectPreset, projects = readProjects()): ProjectPreset[] {
  const normalized = normalizeProject(project);
  if (!normalized) throw new Error("Invalid project preset.");
  const byId = projects.filter((item) => item.id !== normalized.id && item.name.toLocaleLowerCase() !== normalized.name.toLocaleLowerCase());
  return [normalized, ...byId].slice(0, 100);
}

export function deleteProject(id: string, projects = readProjects()): ProjectPreset[] {
  return projects.filter((project) => project.id !== id);
}

function sensitiveExportName(name: string): boolean {
  return /api[_-]?key|authorization|connection[_-]?string|credential|password|private[_-]?key|secret|token/i.test(name);
}

function sensitiveExportFlag(value: string): boolean {
  return /^--(?:api-key|authorization|password|private-key|secret|token)(?:=|$)/i.test(value);
}

function redactExportValue(value: unknown, key = ""): unknown {
  if (sensitiveExportName(key)) return "[REDACTED]";
  if (Array.isArray(value)) {
    let redactNext = false;
    return value.map((item) => {
      if (redactNext) {
        redactNext = false;
        return "[REDACTED]";
      }
      if (typeof item === "string") {
        if (sensitiveExportFlag(item) && item.includes("=")) {
          return `${item.slice(0, item.indexOf("="))}=[REDACTED]`;
        }
        redactNext = sensitiveExportFlag(item);
        return item;
      }
      return redactExportValue(item);
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactExportValue(entryValue, entryKey)]),
    );
  }
  return value;
}

export function exportProject(project: ProjectPreset): string {
  return JSON.stringify({ schema: "llama-board.project.v1", project: redactExportValue(project) }, null, 2);
}

export function importProject(raw: string): ProjectPreset {
  const parsed: unknown = JSON.parse(raw);
  const source = parsed && typeof parsed === "object" && "project" in parsed ? (parsed as { project: unknown }).project : parsed;
  const project = normalizeProject(source);
  if (!project) throw new Error("The selected file is not a valid llama-board project preset.");
  return { ...project, id: `project-${Date.now().toString(36)}`, updatedAt: Date.now() };
}

export function projectConfigPatch(project: ProjectPreset): Partial<AppConfig> {
  return { ...project.config };
}
