import type { ChatHistoryMessage } from "../chatHistory";
import type { ChatTextKey } from "../chatI18n";

interface MessageBubbleProps {
  message: ChatHistoryMessage;
  index: number;
  messageCount: number;
  phase: "idle" | "thinking" | "streaming";
  copied: boolean;
  compact: boolean;
  text: (key: ChatTextKey) => string;
  onCopy: (text: string) => void;
}

export default function MessageBubble({ message, index, messageCount, phase, copied, compact, text, onCopy }: MessageBubbleProps) {
  return (
    <div className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={`group relative max-w-[min(88%,56rem)] min-w-0 rounded-2xl px-4 py-2.5 text-sm ${compact ? "chat-message-compact" : ""} ${message.role === "user" ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-100"}`}>
        {message.role === "assistant" && message.reasoning && (
          <details className="mb-2 rounded border border-slate-700/80 bg-slate-900/50 px-2 py-1 text-xs text-slate-400">
            <summary className="cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{text("thinking")}</summary>
            <div className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{message.reasoning}</div>
          </details>
        )}
        {message.images?.length ? <div className="mb-2 flex flex-wrap gap-2">{message.images.map((image) => <img key={image.dataUrl} src={image.dataUrl} alt={image.name} loading="lazy" decoding="async" width={144} height={144} className="h-36 w-36 max-h-40 max-w-40 rounded-lg border border-white/20 bg-black/20 object-contain" />)}</div> : null}
        {message.documents?.length ? <div className="mb-2 flex flex-wrap gap-1.5">{message.documents.map((document) => <span key={document.path} className="rounded-md border border-white/20 bg-black/10 px-2 py-1 text-[11px]">{text("document")} · {document.name}</span>)}</div> : null}
        <div className="whitespace-pre-wrap break-words">{message.content || (phase === "thinking" && index === messageCount - 1 ? <span className="animate-pulse text-slate-400">{text("thinking")}</span> : "")}</div>
        {message.interrupted && <div className="mt-2 text-[11px] text-amber-300" role="status">{text("interrupted")}</div>}
        {message.failed && <div className="mt-2 text-[11px] text-red-300" role="alert">{text("partialFailed")}</div>}
        {message.role === "assistant" && message.content && <button type="button" onClick={() => onCopy(message.content)} className="app-button app-button--secondary app-button--sm mt-2 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100" aria-label={text("copy")}>{copied ? text("copied") : text("copy")}</button>}
      </div>
    </div>
  );
}
