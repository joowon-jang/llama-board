import { useEffect, useMemo, useState } from "react";
import type { AppStore } from "../store";
import type { AppConfig } from "../api";
import {
  activeProjectId,
  deleteProject,
  exportProject,
  importProject,
  projectConfigPatch,
  projectFromConfig,
  PROJECTS_CHANGED_EVENT,
  readProjects,
  setActiveProjectId,
  upsertProject,
  writeProjects,
  type ProjectPreset,
} from "../projectStore";

function fileName(project: ProjectPreset): string {
  return `${project.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "llama-board-project"}.json`;
}

function inputValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export default function ProjectsPanel({ store }: { store: AppStore }) {
  const [projects, setProjects] = useState<ProjectPreset[]>(readProjects);
  const [selectedId, setSelectedId] = useState<string | null>(() => activeProjectId());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful assistant.");
  const [model, setModel] = useState("");
  const [backend, setBackend] = useState("");
  const [build, setBuild] = useState("");
  const [mmproj, setMmproj] = useState("");
  const [ctxSize, setCtxSize] = useState("4096");
  const [ngl, setNgl] = useState("0");
  const [threads, setThreads] = useState("0");
  const [temperature, setTemperature] = useState("0.8");
  const [topP, setTopP] = useState("0.95");
  const [topK, setTopK] = useState("40");
  const [serverArgs, setServerArgs] = useState("");
  const [chatOptions, setChatOptions] = useState("{}");
  const [toolIds, setToolIds] = useState("");
  const [documentPaths, setDocumentPaths] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cfg = store.cfg;
  const serverRunning = store.status.state === "running" || store.status.state === "starting" || store.status.state === "stopping";
  const selected = useMemo(() => projects.find((project) => project.id === selectedId) ?? null, [projects, selectedId]);

  const loadProject = (project: ProjectPreset | null) => {
    if (!project) {
      setSelectedId(null);
      setName("");
      setDescription("");
      setSystemPrompt("You are a helpful assistant.");
      const current = cfg;
      setModel(current?.active_model ?? "");
      setBackend(current?.active_backend ?? "");
      setBuild(current?.active_build ?? "");
      setMmproj(current?.mmproj ?? "");
      setCtxSize(inputValue(current?.ctx_size ?? 4096));
      setNgl(inputValue(current?.ngl ?? 0));
      setThreads(inputValue(current?.threads ?? 0));
      setTemperature(inputValue(current?.temperature ?? 0.8));
      setTopP(inputValue(current?.top_p ?? 0.95));
      setTopK(inputValue(current?.top_k ?? 40));
      setServerArgs((current?.server_args ?? []).join("\n"));
      setChatOptions(JSON.stringify(current?.chat_options ?? {}, null, 2));
      setToolIds("");
      setDocumentPaths("");
      return;
    }
    setSelectedId(project.id);
    setName(project.name);
    setDescription(project.description);
    setSystemPrompt(project.systemPrompt);
    setModel(project.config.active_model);
    setBackend(project.config.active_backend);
    setBuild(project.config.active_build);
    setMmproj(project.config.mmproj);
    setCtxSize(inputValue(project.config.ctx_size));
    setNgl(inputValue(project.config.ngl));
    setThreads(inputValue(project.config.threads));
    setTemperature(inputValue(project.config.temperature));
    setTopP(inputValue(project.config.top_p));
    setTopK(inputValue(project.config.top_k));
    setServerArgs(project.config.server_args.join("\n"));
    setChatOptions(JSON.stringify(project.config.chat_options, null, 2));
    setToolIds(project.toolIds.join("\n"));
    setDocumentPaths(project.documentBindings.map((document) => document.path).join("\n"));
  };

  useEffect(() => {
    loadProject(selected);
    // A selection change intentionally rehydrates the editor from the stored preset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    const refresh = () => {
      const next = readProjects();
      setProjects(next);
      const active = activeProjectId();
      setSelectedId(active && next.some((project) => project.id === active) ? active : next[0]?.id ?? null);
    };
    window.addEventListener(PROJECTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, refresh);
  }, []);

  const parseNumber = (raw: string, label: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
    return value;
  };

  const buildConfig = (): AppConfig => {
    if (!cfg) throw new Error("Configuration is still loading.");
    let parsedChatOptions: AppConfig["chat_options"];
    try {
      const parsed: unknown = JSON.parse(chatOptions || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Advanced chat options must be a JSON object.");
      parsedChatOptions = parsed as AppConfig["chat_options"];
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : "Advanced chat options JSON is invalid.");
    }
    return {
      ...cfg,
      active_model: model.trim(),
      active_backend: backend.trim(),
      active_build: build.trim(),
      mmproj: mmproj.trim(),
      ctx_size: parseNumber(ctxSize, "Context size"),
      ngl: parseNumber(ngl, "GPU layers"),
      threads: parseNumber(threads, "Threads"),
      temperature: parseNumber(temperature, "Temperature"),
      top_p: parseNumber(topP, "Top-p"),
      top_k: parseNumber(topK, "Top-k"),
      server_args: serverArgs.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      chat_options: parsedChatOptions,
    };
  };

  const save = () => {
    try {
      const bindings = documentPaths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).map((path) => ({
        path,
        name: path.split(/[\\/]/).pop() || path,
      }));
      const project = projectFromConfig(name, systemPrompt, buildConfig(), bindings, toolIds.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean), description);
      const existing = selectedId ? projects.find((item) => item.id === selectedId) : null;
      const saved = existing ? { ...project, id: existing.id, createdAt: existing.createdAt } : project;
      const next = upsertProject(saved, projects);
      writeProjects(next);
      setProjects(next);
      setSelectedId(saved.id);
      setActiveProjectId(saved.id);
      setNotice(`Saved project “${saved.name}”.`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice(null);
    }
  };

  const apply = async (project: ProjectPreset) => {
    if (serverRunning) {
      setError("Stop the server before applying a project runtime.");
      return;
    }
    try {
      await store.updateConfig(projectConfigPatch(project));
      setActiveProjectId(project.id);
      setNotice(`Applied “${project.name}”. Start the server to use its model/runtime settings.`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = (project: ProjectPreset) => {
    if (!window.confirm(`Delete project “${project.name}”?`)) return;
    const next = deleteProject(project.id, projects);
    writeProjects(next);
    setProjects(next);
    if (selectedId === project.id) {
      setActiveProjectId(next[0]?.id ?? null);
      setSelectedId(next[0]?.id ?? null);
    }
    setNotice(`Deleted “${project.name}”.`);
  };

  const exportSelected = (project: ProjectPreset) => {
    const blob = new Blob([exportProject(project)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName(project);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importSelected = async (file: File | undefined) => {
    if (!file) return;
    try {
      const project = importProject(await file.text());
      const next = upsertProject(project, projects);
      writeProjects(next);
      setProjects(next);
      setSelectedId(project.id);
      setNotice(`Imported “${project.name}”.`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3 sm:p-4">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-300">Projects & Presets</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">Reusable local workspaces</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-500">Bundle a system prompt, model/runtime selection, sampling controls, advanced options, and tool bindings. Presets are local JSON and never contain API credentials.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => loadProject(null)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500">New project</button>
          <label className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700">Import JSON<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { void importSelected(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
        </div>
      </div>
      {error && <div className="mb-3 break-words rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">{error}</div>}
      {notice && <div className="mb-3 rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200" role="status">{notice}</div>}
      <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(14rem,0.65fr)_minmax(0,1.35fr)]">
        <aside className="min-h-0 rounded-xl border border-slate-800 bg-slate-900/50 p-2">
          <div className="px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">Saved projects · {projects.length}</div>
          <div className="space-y-1 overflow-auto">
            {projects.length === 0 && <p className="px-2 py-5 text-xs text-slate-600">No projects yet. Save the current configuration to create one.</p>}
            {projects.map((project) => <div key={project.id} className={`flex items-center gap-1 rounded-lg border ${project.id === selectedId ? "border-fuchsia-500/40 bg-fuchsia-500/10" : "border-transparent hover:bg-slate-800"}`}><button type="button" onClick={() => setSelectedId(project.id)} className="min-w-0 flex-1 px-2.5 py-2 text-left"><span className="block truncate text-xs font-medium text-slate-200">{project.name}</span><span className="mt-0.5 block truncate text-[10px] text-slate-600">{project.config.active_model.split(/[\\/]/).pop() || "no model"}</span></button>{project.id === activeProjectId() && <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">active</span>}</div>)}
          </div>
        </aside>
        <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-slate-400">Project name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Code reviewer" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this workspace for?" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
          </div>
          <label className="mt-3 block text-xs text-slate-400">System prompt<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs text-slate-400">Model path<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="C:\\models\\model.gguf" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Backend<input value={backend} onChange={(event) => setBackend(event.target.value)} placeholder="vulkan" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Runtime build<input value={build} onChange={(event) => setBuild(event.target.value)} placeholder="bXXXX" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Projector (mmproj)<input value={mmproj} onChange={(event) => setMmproj(event.target.value)} placeholder="optional sidecar" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Context<input value={ctxSize} onChange={(event) => setCtxSize(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">GPU layers<input value={ngl} onChange={(event) => setNgl(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Threads<input value={threads} onChange={(event) => setThreads(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Temperature<input value={temperature} onChange={(event) => setTemperature(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Top-p<input value={topP} onChange={(event) => setTopP(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Top-k<input value={topK} onChange={(event) => setTopK(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-4">
            <label className="text-xs text-slate-400">Server arguments · one per line<textarea value={serverArgs} onChange={(event) => setServerArgs(event.target.value)} rows={6} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Advanced chat JSON<textarea value={chatOptions} onChange={(event) => setChatOptions(event.target.value)} rows={6} spellCheck={false} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">MCP tool IDs · one per line<textarea value={toolIds} onChange={(event) => setToolIds(event.target.value)} rows={6} placeholder="server-id:tool-name" className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">Document bindings · one path per line<textarea value={documentPaths} onChange={(event) => setDocumentPaths(event.target.value)} rows={6} placeholder="C:\\docs\\project.md" className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={save} disabled={!name.trim()} className="rounded-lg bg-fuchsia-600 px-3 py-2 text-xs font-medium text-white hover:bg-fuchsia-500 disabled:opacity-40">{selected ? "Update project" : "Save project"}</button>
            {selected && <><button type="button" onClick={() => void apply(selected)} disabled={serverRunning || store.busy} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40">Apply to runtime</button><button type="button" onClick={() => exportSelected(selected)} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700">Export JSON</button><button type="button" onClick={() => remove(selected)} className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300 hover:bg-red-900/60">Delete</button></>}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-600">Applying changes the saved app configuration but never starts or restarts the server automatically. Stop the server before changing model, runtime, or projector settings.</p>
        </section>
      </div>
    </div>
  );
}
