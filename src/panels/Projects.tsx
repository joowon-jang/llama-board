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
import FeedbackBanner from "../components/FeedbackBanner";
import EmptyState from "../components/EmptyState";
import ConfirmDialog from "../components/ConfirmDialog";
import { useI18n } from "../i18n";
import { pt } from "../panelI18n";
import { ut } from "../uiI18n";
import { shouldConfirmDestructive } from "../preferences";


function fileName(project: ProjectPreset): string {
  return `${project.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "llama-board-project"}.json`;
}

function inputValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export default function ProjectsPanel({ store }: { store: AppStore }) {
  const { t, locale } = useI18n();

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
  const [pendingDelete, setPendingDelete] = useState<ProjectPreset | null>(null);

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
    if (!Number.isFinite(value)) throw new Error(ut(locale, "mustBeNumber", { label }));
    return value;
  };

  const buildConfig = (): AppConfig => {
    if (!cfg) throw new Error(ut(locale, "configLoading"));
    let parsedChatOptions: AppConfig["chat_options"];
    try {
      const parsed: unknown = JSON.parse(chatOptions || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(ut(locale, "chatJsonObject"));
      parsedChatOptions = parsed as AppConfig["chat_options"];
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : ut(locale, "chatJsonInvalid"));
    }
    return {
      ...cfg,
      active_model: model.trim(),
      active_backend: backend.trim(),
      active_build: build.trim(),
      mmproj: mmproj.trim(),
      ctx_size: parseNumber(ctxSize, ut(locale, "fieldContext")),
      ngl: parseNumber(ngl, ut(locale, "fieldGpuLayers")),
      threads: parseNumber(threads, ut(locale, "fieldThreads")),
      temperature: parseNumber(temperature, ut(locale, "fieldTemperature")),
      top_p: parseNumber(topP, ut(locale, "fieldTopP")),
      top_k: parseNumber(topK, ut(locale, "fieldTopK")),
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
      setNotice(ut(locale, "savedProjectNamed", { name: saved.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice(null);
    }
  };

  const apply = async (project: ProjectPreset) => {
    if (serverRunning) {
      setError(ut(locale, "stopBeforeApplyProject"));
      return;
    }
    try {
      await store.updateConfig(projectConfigPatch(project));
      setActiveProjectId(project.id);
      setNotice(ut(locale, "appliedProjectNamed", { name: project.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = (project: ProjectPreset) => {
    if (shouldConfirmDestructive()) setPendingDelete(project);
    else confirmRemove(project);
  };

  const confirmRemove = (project: ProjectPreset) => {
    const next = deleteProject(project.id, projects);
    writeProjects(next);
    setProjects(next);
    if (selectedId === project.id) {
      setActiveProjectId(next[0]?.id ?? null);
      setSelectedId(next[0]?.id ?? null);
    }
    setPendingDelete(null);
    setNotice(ut(locale, "deletedProjectNamed", { name: project.name }));
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
      setNotice(ut(locale, "importedProjectNamed", { name: project.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3 sm:p-4">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-300">{t("section.projects")}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">{ut(locale, "projectsTitle")}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-500">{ut(locale, "projectsDescription")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => loadProject(null)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500">{pt(locale, "newProject")}</button>
          <label className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700">{pt(locale, "importJson")}<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { void importSelected(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
        </div>
      </div>
      {error && <FeedbackBanner tone="error" title={pt(locale, "projectActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
      {notice && <FeedbackBanner tone="success" title={pt(locale, "done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      <div className="mb-3 grid gap-2 sm:grid-cols-3" role="group" aria-label={pt(locale, "ariaProjectScope")}>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-500">{pt(locale, "savedWorkspaces")}</div><div className="mt-1 text-sm text-slate-200">{projects.length}</div></div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-500">{pt(locale, "runtimeProfile")}</div><div className="mt-1 text-[11px] text-slate-400">{[ut(locale, "fieldModelPath"), ut(locale, "fieldBackend"), ut(locale, "fieldContext"), ut(locale, "fieldGpuLayers")].join(" · ")}</div></div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-500">{pt(locale, "chatWorkspace")}</div><div className="mt-1 text-[11px] text-slate-400">{[ut(locale, "fieldSystemPrompt"), t("section.sampling"), ut(locale, "fieldDocuments").split(" ·")[0], ut(locale, "fieldToolIds").split(" ·")[0]].join(" · ")}</div></div>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={ut(locale, "deleteProjectTitle")}
        description={pendingDelete ? ut(locale, "deleteProjectBody", { name: pendingDelete.name }) : ""}
        confirmLabel={pt(locale, "deleteProject")}
        onConfirm={() => { if (pendingDelete) confirmRemove(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />
      <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(14rem,0.65fr)_minmax(0,1.35fr)]">
        <aside className="min-h-0 rounded-xl border border-slate-800 bg-slate-900/50 p-2">
          <div className="px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">{ut(locale, "savedProjectsCount")} · {projects.length}</div>
          <div className="space-y-1 overflow-auto">
            {projects.length === 0 && <EmptyState title={pt(locale, "noProjects")} description={ut(locale, "projectsEmptyHint")} action={{ label: pt(locale, "newProject"), onClick: () => loadProject(null) }} icon="＋" />}
            {projects.map((project) => <div key={project.id} className={`app-list-row flex items-center gap-1 ${project.id === selectedId ? "is-selected" : ""}`}><button type="button" onClick={() => setSelectedId(project.id)} className="min-w-0 flex-1 px-2.5 py-2 text-left"><span className="block truncate text-xs font-medium text-slate-200">{project.name}</span><span className="mt-0.5 block truncate text-[10px] text-slate-600">{project.config.active_model.split(/[\\/]/).pop() || ut(locale, "noModelShort")}</span></button>{project.id === activeProjectId() && <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] text-emerald-300">{ut(locale, "active")}</span>}</div>)}
          </div>
        </aside>
        <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-slate-400">{ut(locale, "fieldProjectName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={pt(locale, "projectNamePlaceholder")} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldDescription")}<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={ut(locale, "fieldDescriptionPlaceholder")} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
          </div>
          <label className="mt-3 block text-xs text-slate-400">{ut(locale, "fieldSystemPrompt")}<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs text-slate-400">{ut(locale, "fieldModelPath")}<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="C:\\models\\model.gguf" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldBackend")}<input value={backend} onChange={(event) => setBackend(event.target.value)} placeholder="vulkan" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldBuild")}<input value={build} onChange={(event) => setBuild(event.target.value)} placeholder="bXXXX" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldProjector")}<input value={mmproj} onChange={(event) => setMmproj(event.target.value)} placeholder={pt(locale, "optionalSidecar")} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldContext")}<input value={ctxSize} onChange={(event) => setCtxSize(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldGpuLayers")}<input value={ngl} onChange={(event) => setNgl(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldThreads")}<input value={threads} onChange={(event) => setThreads(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldTemperature")}<input value={temperature} onChange={(event) => setTemperature(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldTopP")}<input value={topP} onChange={(event) => setTopP(event.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldTopK")}<input value={topK} onChange={(event) => setTopK(event.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-4">
            <label className="text-xs text-slate-400">{ut(locale, "fieldServerArgs")}<textarea value={serverArgs} onChange={(event) => setServerArgs(event.target.value)} rows={6} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldChatJson")}<textarea value={chatOptions} onChange={(event) => setChatOptions(event.target.value)} rows={6} spellCheck={false} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldToolIds")}<textarea value={toolIds} onChange={(event) => setToolIds(event.target.value)} rows={6} placeholder="server-id:tool-name" className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
            <label className="text-xs text-slate-400">{ut(locale, "fieldDocuments")}<textarea value={documentPaths} onChange={(event) => setDocumentPaths(event.target.value)} rows={6} placeholder="C:\\docs\\project.md" className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 font-mono text-[11px] text-slate-100 focus:border-fuchsia-500 focus:outline-none" /></label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={save} disabled={!name.trim()} title={!name.trim() ? ut(locale, "nameRequired") : undefined} className="rounded-lg bg-fuchsia-600 px-3 py-2 text-xs font-medium text-white hover:bg-fuchsia-500 disabled:opacity-40">{selected ? pt(locale, "updateProject") : pt(locale, "saveProject")}</button>
            {selected && <><button type="button" onClick={() => void apply(selected)} disabled={serverRunning || store.busy} title={serverRunning ? ut(locale, "stopBeforeApplyProject") : undefined} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40">{pt(locale, "applyRuntime")}</button><button type="button" onClick={() => exportSelected(selected)} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700">{pt(locale, "exportJson")}</button><button type="button" onClick={() => remove(selected)} className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300 hover:bg-red-900/60">{pt(locale, "delete")}</button></>}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-600">{ut(locale, "projectsFooter")}</p>
        </section>
      </div>
    </div>
  );
}
