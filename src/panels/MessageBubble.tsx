import { memo } from "react";
import type { ChatHistoryMessage } from "../chatHistory";
import type { ChatTextKey } from "../chatI18n";
import { translate } from "../i18nUnified";
import type { Locale } from "../i18nCatalog";

interface MessageBubbleProps {
  message: ChatHistoryMessage;
  index: number;
  messageCount: number;
  phase: "idle" | "thinking" | "streaming";
  copied: boolean;
  compact: boolean;
  locale: Locale;
  onCopy: (index: number, text: string) => void;
}

/**
 * Memoized so a streaming tick — which only replaces the last message's content —
 * doesn't re-render every earlier bubble in a long conversation. That guarantee only
 * holds if every prop here is either a primitive or a reference that stays stable
 * across renders (locale, onCopy), which is why this takes `locale` instead of a
 * per-render-bound text-lookup closure.
 */
// Named export (in addition to the memoized default) exists solely so tests can
// verify the memoization contract itself, by re-wrapping this in `memo()` and
// spying on calls — see MessageBubble.perf.test.tsx.
export function MessageBubble({ message, index, messageCount, phase, copied, compact, locale, onCopy }: MessageBubbleProps) {
  const text = (key: ChatTextKey) => translate(locale, `chat.${key}`);
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} px-1`}>
      <div
        className={`group relative min-w-0 text-[13px] leading-[1.7] ${compact ? "chat-message-compact" : ""} ${
          isUser
            ? "max-w-[68%] rounded-2xl rounded-br-md border px-3.5 py-2.5"
            : "max-w-[78%] px-1 py-2"
        }`}
        style={
          isUser
            ? {
                background: "var(--board-panel-raised)",
                borderColor: "var(--board-border)",
                color: "var(--board-ink)",
              }
            : { color: "var(--board-ink)" }
        }
      >
        {message.role === "assistant" && message.reasoning && (
          <details className="mb-2.5 rounded-lg border px-2.5 py-2 text-xs leading-relaxed" style={{ borderColor: "var(--board-border)", background: "var(--board-surface-muted)", color: "var(--board-muted)" }}>
            <summary className="cursor-pointer select-none font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-focus)]" style={{ color: "var(--board-faint)" }}>{text("thinking")}</summary>
            <div className="mt-1.5 whitespace-pre-wrap break-words">{message.reasoning}</div>
          </details>
        )}
        {message.images?.length ? <div className="mb-2.5 flex flex-wrap gap-2">{message.images.map((image) => <img key={image.dataUrl} src={image.dataUrl} alt={image.name} loading="lazy" decoding="async" width={144} height={144} className="h-36 w-36 max-h-40 max-w-40 rounded-lg border object-contain" style={{ borderColor: "var(--board-border)", background: "var(--board-mono-bg)" }} />)}</div> : null}
        {message.documents?.length ? <div className="mb-2 flex flex-wrap gap-1.5">{message.documents.map((document) => <span key={document.path} className="rounded-full border px-2.5 py-1 text-[11px] font-medium" style={{ borderColor: "var(--board-border)", background: "var(--board-surface-muted)", color: "var(--board-muted)" }}>{text("document")} · {document.name}</span>)}</div> : null}
        <div className="whitespace-pre-wrap break-words">{message.content || (phase === "thinking" && index === messageCount - 1 ? <span className="animate-pulse" style={{ color: "var(--board-faint)" }}>{text("thinking")}</span> : "")}</div>
        {message.interrupted && <div className="mt-2 text-xs" style={{ color: "var(--board-warning)" }} role="status">{text("interrupted")}</div>}
        {message.failed && <div className="mt-2 text-xs" style={{ color: "var(--board-danger)" }} role="alert">{text("partialFailed")}</div>}
        {message.role === "assistant" && message.content && <button type="button" onClick={() => onCopy(index, message.content)} className="app-button app-button--secondary app-button--sm mt-2.5 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100" aria-label={text("copy")}>{copied ? text("copied") : text("copy")}</button>}
      </div>
    </div>
  );
}

export default memo(MessageBubble);
