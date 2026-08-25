import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { formatBytes, isMmprojPath, quantLabel, validateHfRepoId } from "../discoverUtils";

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export default function DiscoverPanel({ store, active = true }: { store: AppStore; active?: boolean }) {
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
      setError("Enter a model family or Hugging Face search term.");
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
      setError("The selected repository identifier is invalid.");
      return;
    }
    if (!["stopped", "failed", "crashed"].includes(store.status.state)) {
      setError("Stop the server before downloading and selecting a new model or projector.");
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
        setNotice(`Downloaded and selected projector: ${file.path}`);
      } else {
        await store.updateConfig({ active_model: downloaded.path });
        setNotice(`Downloaded and selected model: ${file.path}`);
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
    <div className="flex h-full min-h-0 flex-col p-3 sm:p-4">
      <div className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Discover</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">Find GGUF models on Hugging Face</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">Search public llama.cpp-compatible repositories, inspect their exact files, and download directly into your configured model library.</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-right text-[11px] text-slate-500">
          <div>Destination</div>
          <div className="mt-0.5 max-w-[18rem] truncate text-slate-300" title={store.cfg?.models_dir}>{store.cfg?.models_dir || "Loading…"}</div>
        </div>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void search(); }} className="flex min-w-0 gap-2">
        <label className="sr-only" htmlFor="discover-search">Search Hugging Face models</label>
        <input id="discover-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try: Qwen GGUF, Llama 3, Mistral" className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" />
        <button type="submit" disabled={searching} className="shrink-0 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{searching ? "Searching…" : "Search"}</button>
      </form>

      {error && <div className="mt-3 break-words rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">{error}</div>}
      {notice && <div className="mt-3 break-words rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200" role="status">{notice}</div>}
      {downloading && progress && (
        <div className="mt-3 rounded-xl border border-indigo-800/80 bg-indigo-950/30 p-3" role="status" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-indigo-200">Downloading {progress.file_path}</span>
            <span className="shrink-0 text-indigo-300">{progressPercent}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-indigo-500 transition-[width]" style={{ width: `${progressPercent}%` }} /></div>
          <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-slate-500"><span>{formatBytes(progress.received)} of {formatBytes(progress.total)}</span><button type="button" onClick={() => void cancel()} className="rounded bg-red-900/70 px-2 py-1 text-red-200 hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400">Cancel</button></div>
        </div>
      )}

      <div className="mt-4 grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(24rem,1.15fr)]">
        <section className="min-h-0 overflow-auto rounded-xl border border-slate-800 bg-slate-900/40" aria-label="Hugging Face search results">
          <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Repositories {results.length ? `(${results.length})` : ""}</div>
          {searching && <div className="p-6 text-center text-sm text-slate-500">Searching Hugging Face…</div>}
          {!searching && results.length === 0 && <div className="p-6 text-center text-sm leading-relaxed text-slate-600">Search for a model family to see public GGUF repositories.</div>}
          <div role="list">
            {results.map((model) => (
              <button key={model.id} type="button" role="listitem" onClick={() => void inspect(model)} className={`block w-full border-b border-slate-800 px-3 py-3 text-left last:border-0 hover:bg-slate-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 ${selected?.id === model.id ? "bg-indigo-950/50" : ""}`}>
                <div className="truncate text-sm font-medium text-slate-100">{model.id}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500"><span>{formatCount(model.downloads)} downloads</span><span>♥ {formatCount(model.likes)}</span>{model.gated && <span className="text-amber-400">gated</span>}</div>
                {model.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{model.tags.slice(0, 4).map((tag) => <span key={tag} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">{tag}</span>)}</div>}
              </button>
            ))}
          </div>
        </section>

        <section className="min-h-0 overflow-auto rounded-xl border border-slate-800 bg-slate-900/40" aria-label="Repository files">
          {!selected && <div className="flex h-full min-h-48 items-center justify-center p-6 text-center text-sm leading-relaxed text-slate-600">Select a repository to inspect its GGUF files and choose a quant.</div>}
          {selected && <>
            <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 px-4 py-3"><div className="truncate text-sm font-semibold text-slate-100">{selected.id}</div><div className="mt-1 text-xs text-slate-500">Exact files from the repository tree · {selected.pipeline_tag || "llama.cpp"}</div></div>
            {loadingFiles && <div className="p-6 text-center text-sm text-slate-500">Reading repository files…</div>}
            {!loadingFiles && files?.length === 0 && <div className="p-6 text-center text-sm text-slate-600">No GGUF files were found in this repository.</div>}
            {!loadingFiles && files && files.length > 0 && <div role="list">
              {files.map((file) => {
                const activeDownload = downloading === file.path;
                return <div key={file.path} role="listitem" className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 last:border-0">
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-slate-200" title={file.path}>{file.path}</div><div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500"><span>{formatBytes(file.size_bytes)}</span><span>{file.is_mmproj ? "vision projector" : quantLabel(file.path)}</span>{file.oid && <span title={file.oid}>checksum metadata</span>}</div></div>
                  <button type="button" onClick={() => void download(file)} disabled={!!downloading || !["stopped", "failed", "crashed"].includes(store.status.state)} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{activeDownload ? "Downloading…" : file.is_mmproj ? "Download projector" : "Download"}</button>
                </div>;
              })}
            </div>}
          </>}
        </section>
      </div>
    </div>
  );
}
