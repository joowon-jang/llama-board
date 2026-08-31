import type { RefObject } from "react";
import type * as api from "../api";
import type { ChatHistoryMessage } from "../chatHistory";
import type { ChatTextKey } from "../chatI18n";
import type { Locale } from "../i18nCatalog";
import { normalizeDisplayText } from "../lifecycleUtils";
import MessageBubble from "./MessageBubble";

interface ChatMessageLogProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScrollAtBottomChange: (atBottom: boolean) => void;
  disabled: boolean;
  status: api.ServerStatus;
  model: string;
  serverOn: boolean;
  msgs: ChatHistoryMessage[];
  streamingDraft: { content: string; reasoning: string } | null;
  phase: "idle" | "thinking" | "streaming";
  copiedIndex: number | null;
  compactMessages: boolean;
  locale: Locale;
  onCopy: (index: number, text: string) => void;
  error: string | null;
  canRetry: boolean;
  onRetry: () => void;
  ct: (key: ChatTextKey) => string;
  onOpenModels?: () => void;
  onOpenDiagnostics?: () => void;
  onStart: () => void;
  starting: boolean;
}

export default function ChatMessageLog({
  scrollRef, onScrollAtBottomChange, disabled, status, model, serverOn, msgs, streamingDraft, phase,
  copiedIndex, compactMessages, locale, onCopy, error, canRetry, onRetry, ct,
  onOpenModels, onOpenDiagnostics, onStart, starting,
}: ChatMessageLogProps) {
  const isFailed = status.state === "failed" || status.state === "crashed";
  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="off"
      aria-label={ct("conversation")}
      onScroll={(event) => {
        const element = event.currentTarget;
        onScrollAtBottomChange(element.scrollTop + element.clientHeight >= element.scrollHeight - 80);
      }}
      className="min-h-0 flex-1 space-y-4 overflow-auto px-1 py-2"
    >
      {disabled && (
        <div className="app-chat-blocked mx-auto mt-10 max-w-xl">
          <div className="app-empty-icon" aria-hidden="true">
            {isFailed ? (
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 7v5M10 13.5h.01" strokeLinecap="round" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M10 3.5 11.8 8.2H16.5L12.6 10.9 13.9 15.5 10 12.8 6.1 15.5 7.4 10.9 3.5 8.2H8.2L10 3.5Z" /></svg>
            )}
          </div>
          <h3>{isFailed ? ct("requestFailed") : !model ? ct("openModels") : serverOn ? ct("startingServer") : ct("modelReady")}</h3>
          <p>{isFailed ? ct("blockedFailedDescription") : !model ? ct("blockedNoModelDescription") : serverOn ? ct("blockedStartingDescription") : ct("blockedStoppedDescription")}</p>
          <div className="app-empty-actions">
            {!model && onOpenModels && <button type="button" className="app-button app-button--primary" onClick={onOpenModels}>{ct("openModels")}</button>}
            {model && !serverOn && !isFailed && <button type="button" className="app-button app-button--primary" onClick={onStart} disabled={starting}>{starting || status.state === "starting" ? ct("startingServer") : ct("startServer")}</button>}
            {isFailed && onOpenDiagnostics && <button type="button" className="app-button app-button--secondary" onClick={onOpenDiagnostics}>{ct("openDiagnostics")}</button>}
          </div>
        </div>
      )}

      {!disabled && msgs.length === 0 && (
        <div className="mx-auto mt-12 max-w-md px-4 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl border" style={{ borderColor: "var(--board-border)", background: "var(--board-surface-muted)", color: "var(--board-faint)" }} aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 5.5a1.6 1.6 0 0 1 1.6-1.6h7.8a1.6 1.6 0 0 1 1.6 1.6v5.4a1.6 1.6 0 0 1-1.6 1.6H8.3L5.8 14V12.5A1.6 1.6 0 0 1 4.5 11V5.5Z" /><path d="M7 7.2h6M7 9.7h3.5" strokeWidth="1.2" /></svg>
          </div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--board-ink)" }}>{ct("newConversationTitle")}</h3>
          <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--board-muted)" }}>{ct("newConversationDescription")}</p>
        </div>
      )}

      {msgs.map((message, index) => (
        <MessageBubble
          key={`${message.role}-${index}`}
          message={streamingDraft && index === msgs.length - 1 && message.role === "assistant" ? { ...message, content: streamingDraft.content, reasoning: streamingDraft.reasoning } : message}
          index={index}
          messageCount={msgs.length}
          phase={phase}
          copied={copiedIndex === index}
          compact={compactMessages}
          locale={locale}
          onCopy={onCopy}
        />
      ))}

      {error && <div className="rounded-lg border p-3 text-xs leading-relaxed" style={{ borderColor: "var(--tone-error-border)", background: "var(--tone-error-bg)", color: "var(--tone-error-ink)" }} role="alert">
        <div className="mb-1 text-xs font-semibold">{ct("requestFailed")}</div>
        <div className="whitespace-pre-wrap break-words opacity-90">{normalizeDisplayText(error)}</div>
        {canRetry && <button type="button" onClick={onRetry} disabled={!serverOn || phase !== "idle"} className="app-button app-button--danger mt-2.5 app-button--sm">{ct("retry")}</button>}
      </div>}
    </div>
  );
}
