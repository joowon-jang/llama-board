import type { KeyboardEvent } from "react";
import type * as api from "../api";
import type { DocumentAttachment, ImageAttachment } from "../chatUtils";
import type { ChatTextKey } from "../chatI18n";
import type { ChatMcpTool } from "./useChatMcpTools";
import type { ChatMetrics, PendingToolCall } from "./useChatSend";

interface ChatComposerProps {
  contextWarning: string | null;
  contextSources: string[];
  mcpCatalog: ChatMcpTool[];
  selectedMcpTools: string[];
  toggleMcpTool: (key: string) => void;
  loadingMcpTools: boolean;
  refreshMcpTools: () => void;
  mcpDefinitions: api.ChatToolDefinition[];
  pendingToolCall: PendingToolCall | null;
  onApproveTool: () => void;
  onRejectTool: () => void;
  attachments: ImageAttachment[];
  onRemoveAttachment: (dataUrl: string) => void;
  attachmentStatus: "idle" | "reading" | "ready" | "failed";
  documents: DocumentAttachment[];
  onRemoveDocument: (path: string) => void;
  input: string;
  setInput: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  phase: "idle" | "thinking" | "streaming";
  onAddDocument: () => void;
  onAddImage: () => void;
  onStop: () => void;
  aborting: boolean;
  onSend: () => void;
  canSend: boolean;
  model: string;
  displayModel: string;
  msgsLength: number;
  metrics: ChatMetrics | null;
  ct: (key: ChatTextKey) => string;
}

export default function ChatComposer({
  contextWarning, contextSources, mcpCatalog, selectedMcpTools, toggleMcpTool, loadingMcpTools, refreshMcpTools,
  mcpDefinitions, pendingToolCall, onApproveTool, onRejectTool, attachments, onRemoveAttachment, attachmentStatus,
  documents, onRemoveDocument, input, setInput, onKeyDown, disabled, phase, onAddDocument, onAddImage, onStop,
  aborting, onSend, canSend, model, displayModel, msgsLength, metrics, ct,
}: ChatComposerProps) {
  return (
    <>
      {(contextWarning || contextSources.length > 0) && (
        <div className="chat-context-slot mt-2">
          {contextWarning && <div className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed" style={{ borderColor: "var(--tone-warning-border)", background: "var(--tone-warning-bg)", color: "var(--tone-warning-ink)" }} role="status" aria-label={ct("contextWarningLabel")}><span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--board-warning)]" aria-hidden="true" />{contextWarning}</div>}
          {contextSources.length > 0 && <div className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: "var(--board-border)", background: "var(--board-surface-muted)", color: "var(--board-muted)" }} role="status"><span className="font-medium" style={{ color: "var(--board-ink)" }}>{ct("contextSources")}</span><span className="mx-1.5 opacity-40">·</span>{contextSources.join(" · ")}</div>}
        </div>
      )}

      <div className="chat-mcp-tools mt-2.5 rounded-lg border p-3" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={refreshMcpTools} disabled={disabled || phase !== "idle" || loadingMcpTools} className="app-button app-button--secondary app-button--sm">{loadingMcpTools ? ct("loadingMcpTools") : ct("loadMcpTools")}</button>
          <span className="text-[11px]" style={{ color: "var(--board-faint)" }}>{mcpDefinitions.length ? `${mcpDefinitions.length} tools · ${ct("mcpApproval")}` : ct("mcpOptional")}</span>
        </div>
        {mcpCatalog.length > 0 && (
          <div className="chat-mcp-catalog-slot">
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">{mcpCatalog.map((entry) => { const key = `${entry.serverId}:${entry.tool.name}`; const checked = selectedMcpTools.includes(key); return <label key={key} className="flex max-w-full items-center gap-1.5 text-[11px]" style={{ color: "var(--board-muted)" }}><input type="checkbox" checked={checked} onChange={() => toggleMcpTool(key)} disabled={phase !== "idle"} style={{ accentColor: "var(--board-accent-solid)" }} /><span className="max-w-52 truncate" title={`${entry.serverName}: ${entry.tool.name}`}>{entry.serverName} · {entry.tool.name}</span></label>; })}</div>
          </div>
        )}
      </div>

      <div className="chat-pending-tool-slot">
        {pendingToolCall && <div className="rounded-lg border p-3.5 text-xs shadow-xl" style={{ borderColor: "var(--tone-warning-border)", background: "var(--tone-warning-bg)", color: "var(--tone-warning-ink)" }} role="alert"><div className="font-semibold">{ct("mcpApprovalRequired")}</div><p className="mt-1"><span style={{ color: "var(--board-ink)" }}>{pendingToolCall.serverName}</span> <span className="opacity-40">·</span> <code className="rounded px-1 py-0.5 font-mono text-[11px]" style={{ background: "var(--board-mono-bg)", color: "var(--board-mono-ink)" }}>{pendingToolCall.toolName}</code></p><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded p-2.5 font-mono text-[11px]" style={{ background: "rgb(0 0 0 / 18%)", color: "inherit" }}>{JSON.stringify(pendingToolCall.argumentsValue, null, 2)}</pre><div className="mt-3 flex gap-2"><button type="button" onClick={onApproveTool} className="app-button app-button--primary app-button--sm">{ct("approveTool")}</button><button type="button" onClick={onRejectTool} className="app-button app-button--secondary app-button--sm">{ct("rejectTool")}</button></div></div>}
      </div>

      {attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={ct("pendingImages")}>{attachments.map((image) => <div key={image.dataUrl} className="relative"><img src={image.dataUrl} alt={image.name} width={64} height={64} className="h-16 w-16 rounded-lg border object-cover" style={{ borderColor: "var(--board-border)" }} /><button type="button" onClick={() => onRemoveAttachment(image.dataUrl)} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-white" style={{ background: "var(--board-danger-solid)", borderColor: "var(--board-surface)" }} aria-label={`${ct("removeAttachment")}: ${image.name}`}><svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}

      <div className="chat-attachment-status-slot mt-2">
        {attachmentStatus !== "idle" && <div className="text-xs" style={{ color: "var(--board-faint)" }} role="status" aria-live="polite">{attachmentStatus === "reading" ? ct("attachmentReading") : attachmentStatus === "ready" ? ct("attachmentReady") : ct("attachmentFailed")}</div>}
      </div>

      {documents.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={ct("pendingDocuments")}>{documents.map((document) => <div key={document.path} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs" style={{ borderColor: "var(--board-border)", background: "var(--board-surface-muted)", color: "var(--board-muted)" }}><span className="max-w-48 truncate">{document.name}</span><button type="button" onClick={() => onRemoveDocument(document.path)} className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-[var(--board-panel)]" style={{ color: "var(--board-faint)" }} aria-label={`${ct("removeAttachment")}: ${document.name}`}><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}

      <div className="chat-composer-actions mt-3 flex min-w-0 items-end gap-2">
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} disabled={disabled || phase !== "idle"} rows={2} aria-label={ct("chatMessage")} placeholder={disabled ? ct("offline") : ct("placeholder")} className="app-textarea min-h-[52px] min-w-0 flex-1 resize-y p-3 text-[13px] leading-relaxed" />
        <button type="button" onClick={onAddDocument} disabled={disabled || phase !== "idle" || documents.length >= 4} title={ct("attachDocument")} className="app-button app-button--secondary shrink-0" aria-label={ct("attachDocument")}>{ct("attachDocument")}</button>
        <button type="button" onClick={onAddImage} disabled={disabled || phase !== "idle" || attachments.length >= 4} title={ct("attachImage")} className="app-button app-button--secondary shrink-0" aria-label={ct("attachImage")}>{ct("attachImage")}</button>
        {phase !== "idle" ? <button type="button" onClick={onStop} disabled={aborting} className="app-button app-button--danger shrink-0" aria-label={ct("stop")}>{aborting ? ct("stopping") : ct("stop")}</button> : <button type="button" onClick={onSend} disabled={!canSend} className="app-button app-button--primary shrink-0" aria-label={ct("send")}>{ct("send")}</button>}
      </div>

      <div className="mt-2 flex min-h-[1.25rem] min-w-0 justify-between gap-3 text-xs" style={{ color: "var(--board-faint)" }}>
        <span className="min-w-0 truncate tabular-nums" title={displayModel}>{model ? displayModel : ct("empty")}</span>
        <span className="shrink-0 tabular-nums" role="status" aria-live="polite">{phase === "streaming" ? ct("generating") : phase === "thinking" ? ct("waitingFirstToken") : msgsLength === 0 ? ct("emptyConversation") : `${ct("responseReady")} · ${msgsLength} ${ct("messages")}`}</span>
      </div>

      <div className="mt-1 flex min-h-[1rem] min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums" style={{ color: "var(--board-faint)" }} role="status" aria-label={ct("metricsLabel")}>
        {metrics ? (
          <>
            {metrics.promptTokens !== undefined && <span>{ct("metricsPrompt")} {metrics.promptTokens}</span>}
            {metrics.completionTokens !== undefined && <span>{ct("metricsCompletion")} {metrics.completionTokens}</span>}
            {metrics.firstTokenMs !== undefined && <span>{ct("metricsFirstToken")} {Math.round(metrics.firstTokenMs)} ms</span>}
            {metrics.tokensPerSecond !== undefined && <span>{metrics.tokensPerSecond.toFixed(1)} {ct("metricsTps")}</span>}
          </>
        ) : null}
      </div>
    </>
  );
}
