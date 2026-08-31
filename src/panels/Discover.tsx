import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { formatBytes, isMmprojPath, quantLabel, validateHfRepoId } from "../discoverUtils";
import FeedbackBanner from "../components/FeedbackBanner";
import { useI18n } from "../i18n";
import { normalizeDisplayPath } from "../lifecycleUtils";


function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export default function DiscoverPanel({ store, active = true }: { store: AppStore; active?: boolean }) {
  const { t, locale } = useI18n();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.HfModel[]>([]);
  const [selected, setSelected] = useState<api.HfModel | null>(null);
  const [files, setFiles] = useState<api.HfFile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<api.ModelDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const inspectGeneration = useRef(0);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void api.onModelDownloadProgress((next) => {
      if (!disposed) setProgress(next);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active]);

  const search = async () => {
    const generation = ++searchGeneration.current;
    setError(null);
    setNotice(null);
    setSelected(null);
    setFiles(null);
    if (!query.trim()) {
      setError(t("ui.enterSearchTerm"));
      return;
    }
    setSearching(true);
    try {
      const next = await api.hfSearchModels(query.trim(), 30);
      if (generation === searchGeneration.current) setResults(next);
    } catch (caught) {
      if (generation === searchGeneration.current) {
        setResults([]);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  };

  const inspect = async (model: api.HfModel) => {
    const generation = ++inspectGeneration.current;
    setSelected(model);
    setFiles(null);
    setError(null);
    setNotice(null);
    setLoadingFiles(true);
    try {
      const next = await api.hfModelFiles(model.id);
      if (generation === inspectGeneration.current) setFiles(next);
    } catch (caught) {
      if (generation === inspectGeneration.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation === inspectGeneration.current) setLoadingFiles(false);
    }
  };

  const download = async (file: api.HfFile) => {
    if (!selected || !store.cfg) return;
    if (!validateHfRepoId(selected.id)) {
      setError(t("ui.invalidRepoId"));
      return;
    }
    if (!["stopped", "failed", "crashed"].includes(store.status.state)) {
      setError(t("ui.stopBeforeDownload"));
      return;
    }
    setDownloading(file.path);
    setProgress({ repo_id: selected.id, file_path: file.path, phase: "starting", received: 0, total: file.size_bytes });
    setError(null);
    setNotice(null);
    try {
      const downloaded = await api.hfDownloadModel(selected.id, file.path, store.cfg.models_dir);
      if (file.is_mmproj || isMmprojPath(file.path)) {
        await store.updateConfig({ mmproj: downloaded.path });
        setNotice(t("ui.downloadedProjector", { file: file.path }));
      } else {
        await store.updateConfig({ active_model: downloaded.path });
        setNotice(t("ui.downloadedModel", { file: file.path }));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDownloading(null);
    }
  };

  const cancel = async () => {
    try {
      await api.hfCancelDownload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.round(progress.received / progress.total * 100))
    : 0;

  return (
    <div className="app-page-scroll discover-panel relative flex h-full min-h-0 flex-col p-4">
      <div className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">{t("section.discover")}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">{t("extra.discoverTitle")}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">{t("extra.discoverDescription")}</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 px-3.5 py-2 text-right text-[11px] text-slate-500">
          <div>{t("panel.destination")}</div>
          <div className="mt-0.5 max-w-[18rem] truncate text-slate-300" title={store.cfg?.models_dir ? normalizeDisplayPath(store.cfg.models_dir) : t("panel.loading")}>{store.cfg?.models_dir ? normalizeDisplayPath(store.cfg.models_dir) : t("panel.loading")}</div>
        </div>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void search(); }} className="mb-4 flex min-w-0 gap-2.5" aria-busy={searching || loadingFiles || downloading !== null}>
        <label className="sr-only" htmlFor="discover-search">{t("extra.search")}</label>
        <input id="discover-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("extra.searchPlaceholder")} className="app-input flex-1 h-10 px-4 text-sm" />
        <button type="submit" disabled={searching} className="discover-search-button app-button app-button--primary app-button--lg shrink-0">{searching ? t("panel.scanning") : t("panel.searchModels")}</button>
      </form>

      <div className="app-panel-feedback-layer" aria-live="polite">
        {error && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.downloadComplete")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
        {downloading && progress && (
        <div className="discover-progress-card rounded-xl border border-indigo-800 bg-indigo-950/30 p-4" role="status">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-indigo-200">{t("ui.downloadingFile", { file: normalizeDisplayPath(progress.file_path) })}</span>
            <span className="shrink-0 text-indigo-300">{progressPercent}%</span>
          </div>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full app-bg-muted" role="progressbar" aria-label={t("ui.downloadProgress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.total > 0 ? progressPercent : undefined}><div className="h-full rounded-full app-bg-accent-solid transition-[width]" style={{ width: `${progressPercent}%` }} /></div>
          <div className="mt-2.5 flex items-center justify-between gap-3 text-[11px] text-slate-500"><span>{t("ui.bytesOfTotal", { received: formatBytes(progress.received), total: formatBytes(progress.total) })}</span><button type="button" onClick={() => void cancel()} className="app-button app-button--danger app-button--sm">{t("panel.cancel")}</button></div>
        </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(24rem,1.15fr)]">
        <section className="min-h-0 overflow-auto rounded-xl border border-slate-800 bg-slate-900/40" aria-label={t("extra.searchResults")}>
          <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("extra.searchResults")} {results.length ? `(${results.length})` : ""}</div>
          {searching && <div className="p-6 text-center text-sm text-slate-500">{t("extra.searching")}</div>}
          {!searching && results.length === 0 && <div className="p-6 text-center text-sm leading-relaxed text-slate-600">{t("ui.searchHint")}</div>}
          <div role="list">
            {results.map((model) => (
              <div key={model.id} role="listitem"><button type="button" onClick={() => void inspect(model)} className={`block w-full border-b border-slate-800 px-4 py-3 text-left last:border-0 app-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 ${selected?.id === model.id ? "bg-indigo-950/50" : ""}`}>
                <div className="truncate text-sm font-medium text-slate-100">{model.id}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500"><span>{formatCount(locale, model.downloads)} {t("panel.downloads")}</span><span>♥ {formatCount(locale, model.likes)}</span>{model.gated && <span className="text-amber-400">{t("panel.gated")}</span>}</div>
                {model.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{model.tags.slice(0, 4).map((tag) => <span key={tag} className="rounded app-bg-muted px-1.5 py-0.5 text-[10px] text-slate-500">{tag}</span>)}</div>}
              </button></div>
            ))}
          </div>
        </section>

        <section className="min-h-0 overflow-auto rounded-xl border border-slate-800 bg-slate-900/40" aria-label={t("panel.ariaRepositoryFiles")}>
          {!selected && <div className="flex h-full min-h-48 items-center justify-center p-6 text-center text-sm leading-relaxed text-slate-600">{t("extra.selectRepository")}</div>}
          {selected && <>
            <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 px-4 py-3"><div className="truncate text-sm font-semibold text-slate-100">{selected.id}</div><div className="mt-1 text-xs text-slate-500">{t("ui.repoFileHint")} · {selected.pipeline_tag || "llama.cpp"}</div></div>
            {loadingFiles && <div className="p-6 text-center text-sm text-slate-500">{t("extra.readingFiles")}</div>}
            {!loadingFiles && files?.length === 0 && <div className="p-6 text-center text-sm text-slate-600">{t("extra.noFiles")}</div>}
            {!loadingFiles && files && files.length > 0 && <div role="list">
              {files.map((file) => {
                const activeDownload = downloading === file.path;
                const displayFilePath = normalizeDisplayPath(file.path);
                return <div key={file.path} role="listitem" className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 last:border-0">
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-slate-200" title={displayFilePath}>{displayFilePath}</div><div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500"><span>{formatBytes(file.size_bytes)}</span><span>{file.is_mmproj ? t("ui.visionProjector") : quantLabel(file.path)}</span>{file.oid && <span title={file.oid}>{t("ui.checksumMetadata")}</span>}</div></div>
                  <button type="button" onClick={() => void download(file)} disabled={!!downloading || !["stopped", "failed", "crashed"].includes(store.status.state)} title={!["stopped", "failed", "crashed"].includes(store.status.state) ? t("ui.stopBeforeDownload") : undefined} className="app-button app-button--primary app-button--sm shrink-0">{activeDownload ? `${t("extra.downloading")}…` : file.is_mmproj ? t("extra.downloadProjector") : t("extra.download")}</button>
                </div>;
              })}
            </div>}
          </>}
        </section>
      </div>
    </div>
  );
}
