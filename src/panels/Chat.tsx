import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";

interface Msg {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

/**
 * §1 Chat — states: disabled (server off) → idle → thinking → streaming → error.
 * Streaming tokens accumulate live; on error the previous message set is kept and
 * a retry is offered. Enter sends, Shift+Enter inserts a newline.
 */
export default function ChatPanel({ store }: { store: AppStore }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
  const [error, setError] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const serverOn = store.status.state === "running";
  const baseUrl = serverOn && store.status.url ? store.status.url : null;
  const model = store.cfg?.active_model ?? "";
  const canSend = serverOn && model && phase === "idle" && !aborting && !store.busy;
  const disabled = !serverOn || !model;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, phase]);

  const send = async () => {
    if (!canSend || !baseUrl) return;
    const text = input.trim();
    if (!text) return;
    setInput("");
    setError(null);
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setPhase("thinking");

    const history: api.ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      ...msgs.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ];
    const ac = new AbortController();
    ctrlRef.current = ac;

    let assistant = "";
    let reasoning = "";
    setMsgs((m) => [...m, { role: "assistant", content: "", reasoning: "" }]);

    try {
      const sampling = {
        temperature: store.cfg?.temperature ?? 0.7,
        top_p: store.cfg?.top_p ?? 0.9,
        top_k: store.cfg?.top_k ?? 40,
      };
      const full = await api.chatStream(baseUrl, model, history, sampling, (delta) => {
        if (delta.reasoning) reasoning += delta.reasoning;
        if (delta.content) {
          setPhase("streaming");
          assistant += delta.content;
        }
        const assistantSnapshot = assistant;
        const reasoningSnapshot = reasoning;
        setMsgs((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = {
            role: "assistant",
            content: assistantSnapshot,
            reasoning: reasoningSnapshot,
          };
          return copy;
        });
      }, ac.signal);

      // Ensure the assistant bubble holds the final accumulated text.
      setMsgs((m) => {
        const copy = m.slice();
        const last = copy[copy.length - 1];
        if (last?.role === "assistant" && last.content !== full) {
          copy[copy.length - 1] = { ...last, content: full };
        }
        return copy;
      });
      setPhase("idle");
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      if (isAbort) {
        // User stopped: keep whatever was generated, no error banner.
        setMsgs((m) => (m.length && m[m.length - 1].role === "assistant" && m[m.length - 1].content === "" ? m.slice(0, -1) : m));
        setPhase("idle");
      } else {
        // Keep prior messages; surface error + offer retry.
        setError(e instanceof Error ? e.message : String(e));
        setPhase("idle");
        setMsgs((m) => (m.length && m[m.length - 1].role === "assistant" && m[m.length - 1].content === "" ? m.slice(0, -1) : m));
      }
    } finally {
      ctrlRef.current = null;
      setAborting(false);
      store.refreshStatus();
    }
  };

  const stop = () => {
    setAborting(true);
    ctrlRef.current?.abort();
    setPhase("idle");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full flex-col p-4">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
        {disabled && (
          <div className="mt-8 rounded-lg border border-slate-700 bg-slate-800/60 p-6 text-center text-sm text-slate-300">
            <p className="mb-2 font-medium text-slate-200">
              {!serverOn ? "Server is offline" : !model ? "No model selected" : ""}
            </p>
            {!serverOn && (
              <p>
                Start the server (see the <span className="text-slate-200">Models</span> tab) to begin chatting.
              </p>
            )}
            {serverOn && !model && (
              <p>
                Select a model in the <span className="text-slate-200">Models</span> tab, then start the server.
              </p>
            )}
          </div>
        )}

        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm ${
                m.role === "user"
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-800 text-slate-100"
              }`}
            >
              {m.role === "assistant" && m.reasoning && (
                <details className="mb-2 rounded border border-slate-700/80 bg-slate-900/50 px-2 py-1 text-xs text-slate-400">
                  <summary className="cursor-pointer select-none">Thinking…</summary>
                  <div className="mt-1 whitespace-pre-wrap leading-relaxed">{m.reasoning}</div>
                </details>
              )}
              {m.content || (phase === "thinking" && i === msgs.length - 1 ? <span className="text-slate-400 animate-pulse">thinking…</span> : "")}
            </div>
          </div>
        ))}

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200">
            <div className="mb-1 font-medium">Request failed</div>
            <div className="whitespace-pre-wrap break-words text-red-300">{error}</div>
            <div className="mt-2">
              <button
                onClick={() => void send()}
                className="rounded bg-red-800 px-3 py-1 text-xs text-red-100 hover:bg-red-700"
              >
                Retry last message
              </button>
            </div>
          </div>
        )}
      </div>

      {/* input */}
      <div className="mt-3 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={2}
          placeholder={disabled ? "Server offline — select a model & start it" : "Message (Enter to send, Shift+Enter for newline)"}
          className="min-h-[3rem] flex-1 resize-none rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
        />
        {phase === "thinking" || phase === "streaming" ? (
          <button
            onClick={stop}
            className="rounded-lg bg-red-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-600"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => void send()}
            disabled={!canSend}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-slate-500">
        <span>
          {model ? `model: ${model}` : "no model"}
          {serverOn && store.status.url ? ` · ${store.status.url}` : ""}
        </span>
        <span>
          {phase === "streaming"
            ? "generating…"
            : phase === "thinking"
              ? "waiting for first token…"
              : msgs.length === 0
                ? "empty conversation"
                : `${msgs.length} message${msgs.length > 1 ? "s" : ""}`}
        </span>
      </div>
    </div>
  );
}
