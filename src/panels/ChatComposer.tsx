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
      <div className="chat-context-slot mt-2.5">
        {contextWarning && <div className="rounded-lg border border-amber-800 bg-amber-950/50 px-3.5 py-2.5 text-xs text-amber-200" role="status" aria-label={ct("contextWarningLabel")}>{contextWarning}</div>}
        {contextSources.length > 0 && <div className="rounded-lg border border-cyan-900 bg-cyan-950/30 px-3.5 py-2.5 text-xs text-cyan-200" role="status"><span className="font-medium">{ct("contextSources")}:</span> {contextSources.join(" · ")}</div>}
      </div>
      <div className="chat-mcp-tools mt-2.5 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={refreshMcpTools} disabled={disabled || phase !== "idle" || loadingMcpTools} className="app-button app-button--secondary app-button--sm">{loadingMcpTools ? ct("loadingMcpTools") : ct("loadMcpTools")}</button>
          <span className="text-[11px] text-slate-600">{mcpDefinitions.length ? `${mcpDefinitions.length} × ${ct("loadMcpTools")} · ${ct("mcpApproval")}` : ct("mcpOptional")}</span>
        </div>
        <div className="chat-mcp-catalog-slot">
          {mcpCatalog.length > 0 && <div className="flex flex-wrap gap-x-3.5 gap-y-1.5">{mcpCatalog.map((entry) => { const key = `${entry.serverId}:${entry.tool.name}`; const checked = selectedMcpTools.includes(key); return <label key={key} className="flex max-w-full items-center gap-1.5 text-[11px] text-slate-400"><input type="checkbox" checked={checked} onChange={() => toggleMcpTool(key)} disabled={phase !== "idle"} className="accent-indigo-500" /><span className="max-w-52 truncate" title={`${entry.serverName}: ${entry.tool.name}`}>{entry.serverName} · {entry.tool.name}</span></label>; })}</div>}
        </div>
      </div>
      <div className="chat-pending-tool-slot">
        {pendingToolCall && <div className="rounded-lg border border-amber-700 bg-amber-950/95 p-3.5 text-xs text-amber-200 shadow-xl" role="alert"><div className="font-medium">{ct("mcpApprovalRequired")}</div><p className="mt-1 text-amber-200">{pendingToolCall.serverName} · <code className="font-mono">{pendingToolCall.toolName}</code></p><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2.5 font-mono text-[11px] text-amber-200">{JSON.stringify(pendingToolCall.argumentsValue, null, 2)}</pre><div className="mt-2.5 flex gap-2"><button type="button" onClick={onApproveTool} className="app-button app-button--primary app-button--sm">{ct("approveTool")}</button><button type="button" onClick={onRejectTool} className="app-button app-button--secondary app-button--sm">{ct("rejectTool")}</button></div></div>}
      </div>
      {attachments.length > 0 && <div className="mt-2.5 flex flex-wrap gap-2.5" role="group" aria-label={ct("pendingImages")}>{attachments.map((image) => <div key={image.dataUrl} className="relative"><img src={image.dataUrl} alt={image.name} width={64} height={64} className="h-16 w-16 rounded-lg border border-slate-700 object-cover" /><button type="button" onClick={() => onRemoveAttachment(image.dataUrl)} className="absolute -right-2 -top-2 rounded-full bg-red-700 px-1.5 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300" aria-label={`${ct("removeAttachment")}: ${image.name}`}>×</button></div>)}</div>}
      <div className="chat-attachment-status-slot mt-2">
        {attachmentStatus !== "idle" && <div className="text-xs text-slate-500" role="status" aria-live="polite">{attachmentStatus === "reading" ? ct("attachmentReading") : attachmentStatus === "ready" ? ct("attachmentReady") : ct("attachmentFailed")}</div>}
      </div>
      {documents.length > 0 && <div className="mt-2.5 flex flex-wrap gap-2" role="group" aria-label={ct("pendingDocuments")}>{documents.map((document) => <div key={document.path} className="flex items-center gap-2 rounded-lg border border-slate-700 app-bg-muted px-3 py-1.5 text-xs text-slate-300"><span className="max-w-48 truncate">{document.name}</span><button type="button" onClick={() => onRemoveDocument(document.path)} className="rounded px-1 text-slate-500 hover:bg-red-900 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300" aria-label={`${ct("removeAttachment")}: ${document.name}`}>×</button></div>)}</div>}
      <div className="chat-composer-actions mt-3 flex min-w-0 items-end gap-2.5">
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} disabled={disabled || phase !== "idle"} rows={2} aria-label={ct("chatMessage")} placeholder={disabled ? ct("offline") : ct("placeholder")} className="app-textarea min-h-[3.25rem] min-w-0 flex-1 resize-y p-3 text-sm" />
        <button type="button" onClick={onAddDocument} disabled={disabled || phase !== "idle" || documents.length >= 4} title={ct("attachDocument")} className="app-button app-button--secondary shrink-0" aria-label={ct("attachDocument")}>{ct("attachDocument")}</button>
        <button type="button" onClick={onAddImage} disabled={disabled || phase !== "idle" || attachments.length >= 4} title={ct("attachImage")} className="app-button app-button--secondary shrink-0" aria-label={ct("attachImage")}>{ct("attachImage")}</button>
        {phase !== "idle" ? <button type="button" onClick={onStop} disabled={aborting} className="app-button app-button--danger shrink-0" aria-label={ct("stop")}>{aborting ? ct("stopping") : ct("stop")}</button> : <button type="button" onClick={onSend} disabled={!canSend} className="app-button app-button--primary shrink-0" aria-label={ct("send")}>{ct("send")}</button>}
      </div>
      <div className="mt-2 flex min-h-[1.25rem] min-w-0 justify-between gap-3 text-xs text-slate-500">
        <span className="min-w-0 truncate" title={displayModel}>{model ? displayModel : ct("empty")}</span>
        <span className="shrink-0" role="status" aria-live="polite">{phase === "streaming" ? ct("generating") : phase === "thinking" ? ct("waitingFirstToken") : msgsLength === 0 ? ct("emptyConversation") : `${ct("responseReady")} · ${msgsLength} ${ct("messages")}`}</span>
      </div>
      <div className="mt-1.5 flex min-h-[1rem] min-w-0 flex-wrap gap-x-3.5 gap-y-1 text-[10px] text-slate-600" role="status" aria-label={ct("metricsLabel")}>
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
