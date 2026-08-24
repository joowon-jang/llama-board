import { useState } from "react";
import { useApp } from "./store";
import ChatPanel from "./panels/Chat";
import ModelsPanel from "./panels/Models";
import TuningPanel from "./panels/Tuning";
import BenchPanel from "./panels/Bench";
import RuntimesPanel from "./panels/Runtimes";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "models", label: "Models" },
  { id: "tuning", label: "Tuning" },
  { id: "bench", label: "Benchmark" },
  { id: "runtimes", label: "Runtimes" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function StatusDot({ state }: { state: "stopped" | "running" | "failed" | "starting" }) {
  const color =
    state === "running"
      ? "bg-emerald-400"
      : state === "failed"
        ? "bg-red-500"
        : state === "starting"
          ? "bg-amber-400 animate-pulse"
          : "bg-slate-500";
  const label =
    state === "running"
      ? "server running"
      : state === "failed"
        ? "server failed"
        : state === "starting"
          ? "starting…"
          : "server stopped";
  return (
    <div className="flex items-center gap-2 text-xs text-slate-300">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      {label}
    </div>
  );
}

export default function App() {
  const store = useApp();
  const [tab, setTab] = useState<TabId>("chat");

  const state = store.busy && store.status.state !== "running" ? "starting" : store.status.state;

  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-100">
      {/* header */}
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-700 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <span className="shrink-0 text-base font-semibold tracking-tight">llama-board</span>
          <nav className="flex min-w-0 max-w-full flex-wrap items-center gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  tab === t.id
                    ? "bg-indigo-600 text-white"
                    : "text-slate-300 hover:bg-slate-800"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div className="ml-auto shrink-0">
          <StatusDot state={state as "stopped" | "running" | "failed" | "starting"} />
        </div>
      </header>

      {/* body */}
      <main className="min-h-0 flex-1 overflow-auto">
        {tab === "chat" && <ChatPanel store={store} />}
        {tab === "models" && <ModelsPanel store={store} />}
        {tab === "tuning" && <TuningPanel store={store} />}
        {tab === "bench" && <BenchPanel store={store} />}
        {tab === "runtimes" && <RuntimesPanel store={store} />}
      </main>
    </div>
  );
}
