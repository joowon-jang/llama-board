import { useRef, useState } from "react";
import "./App.css";
import ChatPanel from "./panels/Chat";
import ModelsPanel from "./panels/Models";
import TuningPanel from "./panels/Tuning";
import BenchPanel from "./panels/Bench";
import RuntimesPanel from "./panels/Runtimes";
import { useAppStore } from "./store";

type Tab = "chat" | "models" | "tuning" | "bench" | "runtimes";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "models", label: "Models" },
  { id: "tuning", label: "Tuning" },
  { id: "bench", label: "Benchmark" },
  { id: "runtimes", label: "Runtimes" },
];

function statusLabel(state: string): string {
  return state === "running" ? "ready" : state;
}

export default function App() {
  const store = useAppStore();
  const [tab, setTab] = useState<Tab>("chat");
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement>>>({});
  const currentIndex = TABS.findIndex((item) => item.id === tab);

  const selectTab = (next: Tab, focus = false) => {
    setTab(next);
    if (focus) {
      window.requestAnimationFrame(() => tabRefs.current[next]?.focus());
    }
  };

  const moveTab = (delta: number) => {
    const next = (currentIndex + delta + TABS.length) % TABS.length;
    selectTab(TABS[next].id, true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950 text-slate-100">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-3">
        <div className="mr-auto flex min-w-0 items-center gap-3">
          <h1 className="truncate text-base font-semibold tracking-tight">llama-board</h1>
          <span
            role="status"
            aria-live="polite"
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] ${
              store.status.state === "running"
                ? "bg-emerald-950 text-emerald-300"
                : store.status.state === "failed" || store.status.state === "crashed"
                  ? "bg-red-950 text-red-300"
                  : "bg-slate-800 text-slate-400"
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            {statusLabel(store.status.state)}
          </span>
        </div>
        <nav
          aria-label="Primary"
          role="tablist"
          className="order-3 flex min-w-0 max-w-full flex-1 flex-wrap gap-1 sm:order-2 sm:flex-none"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              ref={(element) => {
                tabRefs.current[item.id] = element ?? undefined;
              }}
              onClick={() => selectTab(item.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  moveTab(1);
                } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveTab(-1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  selectTab(TABS[0].id, true);
                } else if (event.key === "End") {
                  event.preventDefault();
                  selectTab(TABS[TABS.length - 1].id, true);
                }
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                tab === item.id
                  ? "bg-indigo-600 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="order-2 min-w-0 truncate text-right text-xs text-slate-500 sm:order-3">
          {store.cfg?.active_model ? store.cfg.active_model.split(/[\\/]/).pop() : "no model"}
        </div>
      </header>

      {(store.bootError || store.actionError || store.status.error) && (
        <div className="mx-4 mt-3 flex shrink-0 min-w-0 items-start gap-3 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200" role="alert">
          <div className="min-w-0 flex-1 break-words">
            {store.bootError ?? store.actionError ?? store.status.error}
          </div>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={store.clearErrors}
            className="shrink-0 rounded px-2 py-0.5 text-red-300 hover:bg-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            ×
          </button>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-hidden">
        <section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" hidden={tab !== "chat"} className="h-full min-h-0">
          <ChatPanel store={store} />
        </section>
        <section id="panel-models" role="tabpanel" aria-labelledby="tab-models" hidden={tab !== "models"} className="h-full min-h-0">
          <ModelsPanel store={store} />
        </section>
        <section id="panel-tuning" role="tabpanel" aria-labelledby="tab-tuning" hidden={tab !== "tuning"} className="h-full min-h-0">
          <TuningPanel store={store} />
        </section>
        <section id="panel-bench" role="tabpanel" aria-labelledby="tab-bench" hidden={tab !== "bench"} className="h-full min-h-0">
          <BenchPanel store={store} />
        </section>
        <section id="panel-runtimes" role="tabpanel" aria-labelledby="tab-runtimes" hidden={tab !== "runtimes"} className="h-full min-h-0">
          <RuntimesPanel store={store} />
        </section>
      </main>
    </div>
  );
}
