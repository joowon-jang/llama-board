import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";

interface Msg {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

interface FailedRequest {
  text: string;
  history: api.ChatMessage[];
}

export default function ChatPanel({ store }: { store: AppStore }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
  const [error, setError] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const failedRef = useRef<FailedRequest | null>(null);

  const serverOn = store.status.state === "running";
  const baseUrl = serverOn && store.status.url ? store.status.url : null;
  const apiKey = serverOn ? store.status.api_key ?? "" : "";
  const model = store.cfg?.active_model ?? "";
  const canSend = serverOn && !!apiKey && !!model && phase === "idle" && !aborting && !store.busy;
  const disabled = !serverOn || !model || !apiKey;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, phase]);

  const send = async (retry = false) => {
    if (!canSend || !baseUrl) return;
    const failed = failedRef.current;
    const text = (retry ? failed?.text ?? "" : input).trim();
    if (!text) return;

    const history = retry && failed ? failed.history : [
      { role: "system" as const, content: "You are a helpful assistant." },
      ...msgs.map((message) => ({ role: message.role, content: message.content })),
      { role: "user" as const, content: text },
    ];
    failedRef.current = { text, history };
    setInput("");
    setError(null);
    setPhase("thinking");
    setMsgs((current) => {
      const last = current[current.length - 1];
      const withoutDanglingAssistant = last?.role === "assistant" ? current.slice(0, -1) : current;
      const previous = withoutDanglingAssistant[withoutDanglingAssistant.length - 1];
      const hasUserBubble = previous?.role === "user" && previous.content === text;
      return [...withoutDanglingAssistant, ...(hasUserBubble ? [] : [{ role: "user" as const, content: text }]), { role: "assistant" as const, content: "", reasoning: "" }];
    });

    const controller = new AbortController();
    ctrlRef.current = controller;
    let assistant = "";
    let reasoning = "";
    try {
      const sampling = {
        temperature: store.cfg?.temperature ?? 0.7,
        top_p: store.cfg?.top_p ?? 0.9,
        top_k: store.cfg?.top_k ?? 40,
      };
      const full = await api.chatStream(baseUrl, apiKey, model, history, sampling, (delta) => {
        if (delta.reasoning) reasoning += delta.reasoning;
        if (delta.content) {
          setPhase("streaming");
          assistant += delta.content;
        }
        const contentSnapshot = assistant;
        const reasoningSnapshot = reasoning;
        setMsgs((current) => {
          if (current[current.length - 1]?.role !== "assistant") return current;
          const next = current.slice();
          next[next.length - 1] = { role: "assistant", content: contentSnapshot, reasoning: reasoningSnapshot };
          return next;
        });
      }, controller.signal);

      setMsgs((current) => {
        if (current[current.length - 1]?.role !== "assistant") return current;
        const next = current.slice();
        next[next.length - 1] = { ...next[next.length - 1], content: full };
        return next;
      });
      failedRef.current = null;
      setPhase("idle");
    } catch (caught) {
      const isAbort = controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError");
      setMsgs((current) => (current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current));
      if (isAbort) {
        setPhase("idle");
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase("idle");
      }
    } finally {
      ctrlRef.current = null;
      setAborting(false);
      void store.refreshStatus();
    }
  };

  const stop = () => {
    setAborting(true);
    ctrlRef.current?.abort();
  };

  const copyMessage = async (index: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      window.setTimeout(() => setCopied((current) => (current === index ? null : current)), 1800);
    } catch (caught) {
      setError(`Copy failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div ref={scrollRef} role="log" aria-live="off" aria-label="Conversation" className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
        {disabled && (
          <div className="mx-auto mt-8 max-w-xl rounded-lg border border-slate-700 bg-slate-800/60 p-6 text-center text-sm text-slate-300">
            <p className="mb-2 font-medium text-slate-200">
              {!serverOn ? "Server is offline" : !model ? "No model selected" : "Server authentication is starting"}
            </p>
            <p>
              {!serverOn
                ? "Start the server in Models to begin chatting."
                : !model
                  ? "Select a GGUF model in Models, then start the server."
                  : "Wait for the server to become ready, then try again."}
            </p>
          </div>
        )}

        {msgs.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`group relative max-w-[min(80%,56rem)] min-w-0 rounded-2xl px-4 py-2.5 text-sm ${
                message.role === "user" ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-100"
              }`}
            >
              {message.role === "assistant" && message.reasoning && (
                <details className="mb-2 rounded border border-slate-700/80 bg-slate-900/50 px-2 py-1 text-xs text-slate-400">
                  <summary className="cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Thinking process</summary>
                  <div className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{message.reasoning}</div>
                </details>
              )}
              <div className="whitespace-pre-wrap break-words">
                {message.content || (phase === "thinking" && index === msgs.length - 1 ? <span className="animate-pulse text-slate-400">thinking…</span> : "")}
              </div>
              {message.role === "assistant" && message.content && (
                <button
                  type="button"
                  onClick={() => void copyMessage(index, message.content)}
                  className="mt-2 rounded px-2 py-1 text-[11px] text-slate-400 opacity-0 transition hover:bg-slate-700 hover:text-slate-200 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 group-hover:opacity-100"
                  aria-label="Copy assistant message"
                >
                  {copied === index ? "Copied" : "Copy"}
                </button>
              )}
            </div>
          </div>
        ))}

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200" role="alert">
            <div className="mb-1 font-medium">Request failed</div>
            <div className="whitespace-pre-wrap break-words text-red-300">{error}</div>
            {failedRef.current && (
              <button
                type="button"
                onClick={() => void send(true)}
                disabled={!canSend}
                className="mt-2 rounded bg-red-800 px-3 py-1 text-xs text-red-100 hover:bg-red-700 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
              >
                Retry last message
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex min-w-0 items-end gap-2">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || phase !== "idle"}
          rows={2}
          aria-label="Chat message"
          placeholder={disabled ? "Server offline — select a model and start it" : "Message (Enter to send, Shift+Enter for newline)"}
          className="min-h-[3rem] min-w-0 flex-1 resize-y rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50"
        />
        {phase !== "idle" ? (
          <button
            type="button"
            onClick={stop}
            disabled={aborting}
            className="shrink-0 rounded-lg bg-red-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          >
            {aborting ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend || !input.trim()}
            className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            Send
          </button>
        )}
      </div>
      <div className="mt-1.5 flex min-w-0 justify-between gap-3 text-xs text-slate-500">
        <span className="min-w-0 truncate" title={model}>{model ? `model: ${model}` : "no model"}</span>
        <span className="shrink-0" role="status" aria-live="polite">
          {phase === "streaming" ? "generating…" : phase === "thinking" ? "waiting for first token…" : msgs.length === 0 ? "empty conversation" : `${msgs.length} messages`}
        </span>
      </div>
    </div>
  );
}
