import assert from "node:assert/strict";
import type { AppConfig } from "../src/api.ts";
import {
  activeProjectId,
  deleteProject,
  exportProject,
  importProject,
  projectConfigPatch,
  projectFromConfig,
  readProjects,
  setActiveProjectId,
  upsertProject,
  writeProjects,
} from "../src/projectStore.ts";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, value),
  removeItem: (key: string) => void values.delete(key),
} as Storage;

const config = {
  config_version: 6,
  models_dir: "C:/models",
  port: 8080,
  ngl: 32,
  ctx_size: 8192,
  flash_attn: "on",
  n_cpu_moe: 0,
  threads: 8,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  spec_type: "none",
  spec_draft_n_max: 3,
  spec_draft_n_min: 0,
  spec_draft_p_min: 0,
  spec_draft_p_split: 0.1,
  spec_draft_ngl: "auto",
  spec_draft_device: "",
  spec_draft_model: "",
  reasoning: "auto",
  reasoning_format: "auto",
  reasoning_effort: "default",
  reasoning_budget: -1,
  reasoning_budget_message: "",
  reasoning_preserve: "auto",
  server_args: ["--jinja"],
  chat_options: { min_p: 0.05 },
  mmproj: "",
  active_model: "C:/models/code.gguf",
  active_backend: "vulkan",
  active_build: "b10603",
  iters: 5,
} as AppConfig;

const project = projectFromConfig("Code review", "Review code carefully.", config, [{ name: "rules.md", path: "C:/rules.md" }], ["local:read_file"], "A reusable coding workspace", 100);
let projects = upsertProject(project, []);
writeProjects(projects, storage);
assert.equal(readProjects(storage)[0].name, "Code review");
assert.equal(projectConfigPatch(readProjects(storage)[0]).active_model, "C:/models/code.gguf");
assert.equal(activeProjectId(storage), null);
setActiveProjectId(project.id, storage);
assert.equal(activeProjectId(storage), project.id);

const exported = exportProject(project);
assert.match(exported, /llama-board\.project\.v1/);
assert.doesNotMatch(exported, /api[_-]?key|password|token|secret/i);
const secretProject = projectFromConfig(
  "Secret-free export",
  "Review code carefully.",
  {
    ...config,
    server_args: ["--api-key", "secret-value", "--api-key=inline-secret", "--jinja"],
    chat_options: { headers: { authorization: "secret-value" }, min_p: 0.05 },
  },
  [],
  [],
  "",
  200,
);
const secretExport = exportProject(secretProject);
assert.match(secretExport, /\[REDACTED\]/);
assert.doesNotMatch(secretExport, /secret-value|inline-secret/i);
assert.match(secretExport, /--api-key=\[REDACTED\]/);
const imported = importProject(exported);
projects = upsertProject(imported, readProjects(storage));
assert.equal(projects.length, 1);
assert.equal(projects[0].systemPrompt, "Review code carefully.");
assert.deepEqual(projects[0].toolIds, ["local:read_file"]);
assert.equal(deleteProject(project.id, projects).length, 1);
assert.equal(deleteProject(imported.id, projects).length, 0);
console.log("project store tests passed");
