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
import { shouldConfirmDestructive } from "../preferences";
import { isServerBusy, normalizeDisplayPath, normalizeDisplayPathLines } from "../lifecycleUtils";


function fileName(project: ProjectPreset): string {
  return `${project.name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "llama-board-project"}.json`;
}

function inputValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export default function ProjectsPanel({ store }: { store: AppStore }) {
  const { t } = useI18n();

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
  // Unlike other panels' "server running" guards, Projects also blocks applying a
  // project while the server is starting/stopping: applying rewrites the server
  // config, and that must wait until the server is fully stopped, not just idle.
  const serverRunning = isServerBusy(store.status.state);
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
    if (!Number.isFinite(value)) throw new Error(t("ui.mustBeNumber", { label }));
    return value;
  };

  const buildConfig = (): AppConfig => {
    if (!cfg) throw new Error(t("ui.configLoading"));
    let parsedChatOptions: AppConfig["chat_options"];
    try {
      const parsed: unknown = JSON.parse(chatOptions || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("ui.chatJsonObject"));
      parsedChatOptions = parsed as AppConfig["chat_options"];
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : t("ui.chatJsonInvalid"));
    }
    return {
      ...cfg,
      active_model: model.trim(),
      active_backend: backend.trim(),
      active_build: build.trim(),
      mmproj: mmproj.trim(),
      ctx_size: parseNumber(ctxSize, t("ui.fieldContext")),
      ngl: parseNumber(ngl, t("ui.fieldGpuLayers")),
      threads: parseNumber(threads, t("ui.fieldThreads")),
      temperature: parseNumber(temperature, t("ui.fieldTemperature")),
      top_p: parseNumber(topP, t("ui.fieldTopP")),
      top_k: parseNumber(topK, t("ui.fieldTopK")),
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
      setNotice(t("ui.savedProjectNamed", { name: saved.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setNotice(null);
    }
  };

  const apply = async (project: ProjectPreset) => {
    if (serverRunning) {
      setError(t("ui.stopBeforeApplyProject"));
      return;
    }
    try {
      await store.updateConfig(projectConfigPatch(project));
      setActiveProjectId(project.id);
      setNotice(t("ui.appliedProjectNamed", { name: project.name }));
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
    setNotice(t("ui.deletedProjectNamed", { name: project.name }));
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
      setNotice(t("ui.importedProjectNamed", { name: project.name }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-300">{t("section.projects")}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">{t("ui.projectsTitle")}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-500">{t("ui.projectsDescription")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => loadProject(null)} className="app-button app-button--primary app-button--sm">{t("panel.newProject")}</button>
          <label className="app-button app-button--secondary app-button--sm cursor-pointer">{t("panel.importJson")}<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => { void importSelected(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
        </div>
      </div>
      <div className="app-panel-feedback-layer" aria-live="polite">
        {error && <FeedbackBanner tone="error" title={t("panel.projectActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-3" role="group" aria-label={t("panel.ariaProjectScope")}>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{t("panel.savedWorkspaces")}</div><div className="mt-1 text-sm font-medium text-slate-200">{projects.length}</div></div>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{t("panel.runtimeProfile")}</div><div className="mt-1 text-[11px] text-slate-400">{[t("ui.fieldModelPath"), t("ui.fieldBackend"), t("ui.fieldContext"), t("ui.fieldGpuLayers")].join(" · ")}</div></div>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{t("panel.chatWorkspace")}</div><div className="mt-1 text-[11px] text-slate-400">{[t("ui.fieldSystemPrompt"), t("section.sampling"), t("ui.fieldDocuments").split(" ·")[0], t("ui.fieldToolIds").split(" ·")[0]].join(" · ")}</div></div>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("ui.deleteProjectTitle")}
        description={pendingDelete ? t("ui.deleteProjectBody", { name: pendingDelete.name }) : ""}
        confirmLabel={t("panel.deleteProject")}
        onConfirm={() => { if (pendingDelete) confirmRemove(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />
      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(14rem,0.65fr)_minmax(0,1.35fr)]">
        <aside className="min-h-0 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
          <div className="px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-slate-500">{t("ui.savedProjectsCount")} · {projects.length}</div>
          <div className="space-y-1.5 overflow-auto">
            {projects.length === 0 && <EmptyState title={t("panel.noProjects")} description={t("ui.projectsEmptyHint")} action={{ label: t("panel.newProject"), onClick: () => loadProject(null) }} icon="＋" />}
            {projects.map((project) => <div key={project.id} className={`app-list-row flex items-center justify-between gap-1 px-1 py-1 ${project.id === selectedId ? "is-selected" : ""}`}><button type="button" onClick={() => setSelectedId(project.id)} className="min-w-0 flex-1 px-2.5 py-1.5 text-left"><span className="block truncate text-xs font-medium text-slate-200">{project.name}</span><span className="mt-0.5 block truncate text-[10px] text-slate-600">{normalizeDisplayPath(project.config.active_model).split(/[\\/]/).pop() || t("ui.noModelShort")}</span></button>{project.id === activeProjectId() && <span className="mr-1 rounded bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-300">{t("ui.active")}</span>}</div>)}
          </div>
        </aside>
        <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-slate-400">{t("ui.fieldProjectName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("panel.projectNamePlaceholder")} className="app-input mt-1" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldDescription")}<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("ui.fieldDescriptionPlaceholder")} className="app-input mt-1" /></label>
          </div>
          <label className="mt-3 block text-xs text-slate-400">{t("ui.fieldSystemPrompt")}<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} className="app-textarea mt-1" /></label>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs text-slate-400">{t("ui.fieldModelPath")}<input value={normalizeDisplayPath(model)} onChange={(event) => setModel(event.target.value)} placeholder="C:\\models\\model.gguf" className="app-input mt-1 font-mono" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldBackend")}<input value={backend} onChange={(event) => setBackend(event.target.value)} placeholder="vulkan" className="app-input mt-1" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldBuild")}<input value={build} onChange={(event) => setBuild(event.target.value)} placeholder="bXXXX" className="app-input mt-1 font-mono" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldProjector")}<input value={normalizeDisplayPath(mmproj)} onChange={(event) => setMmproj(event.target.value)} placeholder={t("panel.optionalSidecar")} className="app-input mt-1" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldContext")}<input value={ctxSize} onChange={(event) => setCtxSize(event.target.value)} inputMode="numeric" className="app-input mt-1" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldGpuLayers")}<input value={ngl} onChange={(event) => setNgl(event.target.value)} inputMode="numeric" className="app-input mt-1" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldThreads")}<input value={threads} onChange={(event) => setThreads(event.target.value)} inputMode="numeric" className="app-input mt-1" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldTemperature")}<input value={temperature} onChange={(event) => setTemperature(event.target.value)} inputMode="decimal" className="app-input mt-1" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldTopP")}<input value={topP} onChange={(event) => setTopP(event.target.value)} inputMode="decimal" className="app-input mt-1" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldTopK")}<input value={topK} onChange={(event) => setTopK(event.target.value)} inputMode="numeric" className="app-input mt-1" /></label>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-4">
            <label className="text-xs text-slate-400">{t("ui.fieldServerArgs")}<textarea value={normalizeDisplayPathLines(serverArgs)} onChange={(event) => setServerArgs(event.target.value)} rows={6} className="app-textarea mt-1 app-mono text-[11px]" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldChatJson")}<textarea value={chatOptions} onChange={(event) => setChatOptions(event.target.value)} rows={6} spellCheck={false} className="app-textarea mt-1 app-mono text-[11px]" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldToolIds")}<textarea value={toolIds} onChange={(event) => setToolIds(event.target.value)} rows={6} placeholder="server-id:tool-name" className="app-textarea mt-1 app-mono text-[11px]" /></label>
            <label className="text-xs text-slate-400">{t("ui.fieldDocuments")}<textarea value={normalizeDisplayPathLines(documentPaths)} onChange={(event) => setDocumentPaths(event.target.value)} rows={6} placeholder="C:\\docs\\project.md" className="app-textarea mt-1 app-mono text-[11px]" /></label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2.5">
            <button type="button" onClick={save} disabled={!name.trim()} title={!name.trim() ? t("ui.nameRequired") : undefined} className="app-button app-button--primary app-button--sm">{selected ? t("panel.updateProject") : t("panel.saveProject")}</button>
            {selected && <><button type="button" onClick={() => void apply(selected)} disabled={serverRunning || store.busy} title={serverRunning ? t("ui.stopBeforeApplyProject") : undefined} className="app-button app-button--primary app-button--sm">{t("panel.applyRuntime")}</button><button type="button" onClick={() => exportSelected(selected)} className="app-button app-button--secondary app-button--sm">{t("panel.exportJson")}</button><button type="button" onClick={() => remove(selected)} className="app-button app-button--danger app-button--sm">{t("panel.delete")}</button></>}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-600">{t("ui.projectsFooter")}</p>
        </section>
      </div>
    </div>
  );
}
