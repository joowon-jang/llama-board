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
      className="min-h-0 flex-1 space-y-3 overflow-auto"
    >
      {disabled && (
        <div className="app-chat-blocked mx-auto mt-8 max-w-xl">
          <div className="app-empty-icon" aria-hidden="true">{isFailed ? "!" : "✦"}</div>
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
        <div className="mx-auto mt-10 max-w-lg px-4 text-center">
          <div className="app-soft-accent mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl text-xl" aria-hidden="true">✦</div>
          <h3 className="text-base font-semibold text-slate-100">{ct("newConversationTitle")}</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-500">{ct("newConversationDescription")}</p>
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

      {error && <div className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200" role="alert">
        <div className="mb-1 font-medium">{ct("requestFailed")}</div>
        <div className="whitespace-pre-wrap break-words text-red-300">{normalizeDisplayText(error)}</div>
        {canRetry && <button type="button" onClick={onRetry} disabled={!serverOn || phase !== "idle"} className="app-button app-button--danger mt-2">{ct("retry")}</button>}
      </div>}
    </div>
  );
}
