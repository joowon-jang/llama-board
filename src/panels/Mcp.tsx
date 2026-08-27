import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { formatMcpCommand, validateMcpServerDraft } from "../mcpUtils";
import FeedbackBanner from "../components/FeedbackBanner";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import { useI18n } from "../i18n";
import { pt } from "../panelI18n";
import { ut, type UiTextKey } from "../uiI18n";
import { shouldConfirmDestructive } from "../preferences";
import { approvalKey, canAutoApprove, loadMcpApprovalPolicy, saveMcpApprovalPolicy, type McpApprovalPolicy } from "../lifecycleUtils";


type Approval = { tool: api.McpTool; args: Record<string, unknown> };

function newId() {
  return `mcp-${Date.now().toString(36)}`;
}

const POLICY_LABELS: Record<McpApprovalPolicy, UiTextKey> = {
  "always-ask": "policyAlwaysAsk",
  once: "policyOnce",
  session: "policySession",
  "server-tool": "policyServerTool",
  deny: "policyDeny",
};

export default function McpPanel(_props: { store: AppStore }) {
  const { t, locale } = useI18n();
  const policyLabel = (policy: McpApprovalPolicy) => ut(locale, POLICY_LABELS[policy]);

  const [servers, setServers] = useState<api.McpServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [approvalPolicy, setApprovalPolicy] = useState<McpApprovalPolicy>(() => loadMcpApprovalPolicy());
  const [approvedCalls, setApprovedCalls] = useState<Set<string>>(() => new Set());
  const [tools, setTools] = useState<api.McpTool[]>([]);
  const [toolLoading, setToolLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<api.McpTool | null>(null);
  const [argsJson, setArgsJson] = useState("{}\n");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const approvalBusyRef = useRef(false);
  const [result, setResult] = useState<unknown>(null);
  const [pendingDelete, setPendingDelete] = useState<api.McpServer | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (pendingDelete && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => cancelDeleteRef.current?.focus());
    } else if (!pendingDelete && dialog.open) {
      dialog.close();
    }
  }, [pendingDelete]);

  const closeDeleteDialog = () => {
    const serverId = pendingDelete?.id;
    setPendingDelete(null);
    if (serverId) window.requestAnimationFrame(() => deleteButtonRefs.current[serverId]?.focus());
  };

  const loadServers = async () => {
    try {
      setServers(await api.mcpListServers());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => { void loadServers(); }, []);

  const resetDraft = () => {
    setSelectedId(null);
    setName("");
    setCommand("");
    setArgsText("");
    setEnabled(true);
    setApprovalPolicy(loadMcpApprovalPolicy());
    setApprovedCalls(new Set());
    setTools([]);
    setSelectedTool(null);
    setApproval(null);
    setResult(null);
    setNotice(null);
    setError(null);
  };

  const selectServer = (server: api.McpServer) => {
    setSelectedId(server.id);
    setName(server.name);
    setCommand(server.command);
    setArgsText(server.args.join("\n"));
    setEnabled(server.enabled);
    setTools([]);
    setSelectedTool(null);
    setApproval(null);
    setResult(null);
    setError(null);
  };

  const save = async () => {
    const args = argsText.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const validation = validateMcpServerDraft({ name, command, args, enabled });
    if (validation) { setError(validation); return; }
    const id = selectedId ?? newId();
    try {
      const next = await api.mcpSaveServer({ id, name: name.trim(), command: command.trim(), args, enabled });
      setServers(next);
      setSelectedId(id);
      setNotice(ut(locale, "mcpSaved"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const doRemove = async (server: api.McpServer) => {
    try {
      setServers(await api.mcpRemoveServer(server.id));
      if (selectedId === server.id) resetDraft();
      setNotice(ut(locale, "mcpRemoved"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingDelete(null);
      window.requestAnimationFrame(() => deleteButtonRefs.current[server.id]?.focus());
    }
  };

  const discoverTools = async () => {
    if (!selectedId) return;
    setToolLoading(true);
    setError(null);
    setNotice(null);
    try {
      setTools(await api.mcpListTools(selectedId));
      setNotice(ut(locale, "mcpToolsLoaded"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setToolLoading(false);
    }
  };

  const prepareCall = () => {
    if (!selectedTool) return;
    let parsedArgs: Record<string, unknown>;
    try {
      const parsed = JSON.parse(argsJson) as unknown;
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(ut(locale, "mcpArgsObject"));
      parsedArgs = parsed as Record<string, unknown>;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : ut(locale, "mcpArgsInvalid"));
      return;
    }
    setError(null);
    setResult(null);
    if (approvalPolicy === "deny") {
      setError(ut(locale, "mcpBlockedByPolicy"));
      return;
    }
    const pending = { tool: selectedTool, args: parsedArgs };
    // A "session"/"server-tool" policy only skips the prompt once this exact
    // server+tool pair has been approved by hand at least once.
    if (selectedId && canAutoApprove(approvalPolicy, approvedCalls, approvalKey(selectedId, selectedTool.name))) {
      void runToolCall(pending, true);
      return;
    }
    setApproval(pending);
  };

  const runToolCall = async (pending: Approval, autoApproved: boolean) => {
    if (!selectedId || approvalBusyRef.current) return;
    const serverId = selectedId;
    const key = approvalKey(serverId, pending.tool.name);
    approvalBusyRef.current = true;
    setApprovalBusy(true);
    setApproval(null);
    try {
      setResult(await api.mcpCallTool(serverId, pending.tool.name, pending.args));
      if (approvalPolicy === "session" || approvalPolicy === "server-tool") {
        setApprovedCalls((current) => new Set(current).add(key));
      }
      setNotice(autoApproved
        ? `${ut(locale, "mcpAutoApproved", { policy: policyLabel(approvalPolicy) })} ${ut(locale, "mcpToolCompleted", { name: pending.tool.name })}`
        : ut(locale, "mcpToolCompleted", { name: pending.tool.name }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      approvalBusyRef.current = false;
      setApprovalBusy(false);
    }
  };

  const approveCall = async () => {
    if (!approval) return;
    await runToolCall(approval, false);
  };

  const selectedServer = servers.find((server) => server.id === selectedId);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3 sm:p-4">
      <div className="mb-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-300">{t("section.mcp")}</div><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">{t("section.mcp")}</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-500">{ut(locale, "mcpIntro")}</p></div>
      <div className="mb-3 rounded-lg border border-amber-800/80 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-200">{ut(locale, "mcpWarning")}</div>
      <div className="mb-3 grid gap-2 sm:grid-cols-3" role="group" aria-label={pt(locale, "ariaConfiguredServers")}>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-500">{ut(locale, "mcpServersCount")}</div><div className="mt-1 text-sm text-slate-200">{ut(locale, "mcpConfigured", { count: servers.length })}</div></div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-500">{ut(locale, "enabled")}</div><div className="mt-1"><StatusBadge label={ut(locale, "mcpEnabledCount", { count: servers.filter((server) => server.enabled).length })} tone={servers.some((server) => server.enabled) ? "success" : "neutral"} /></div></div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-500">{ut(locale, "mcpApproval")}</div><div className="mt-1 text-sm text-amber-300">{ut(locale, "mcpApprovalAlways")}</div></div>
      </div>
      {error && <FeedbackBanner tone="error" title={pt(locale, "mcpActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
      {notice && <FeedbackBanner tone="success" title={pt(locale, "done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}

      <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)]">
        <aside className="rounded-xl border border-slate-800 bg-slate-900/50 p-3"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-200">{pt(locale, "configuredServers")}</h3><button type="button" onClick={resetDraft} className="rounded bg-fuchsia-950/70 px-2 py-1 text-[11px] text-fuchsia-200 hover:bg-fuchsia-900">{pt(locale, "newItem")}</button></div><div className="mt-3 space-y-1.5">{servers.length === 0 && <EmptyState title={pt(locale, "noMcpServers")} description={ut(locale, "mcpEmptyHint")} action={{ label: pt(locale, "newItem"), onClick: resetDraft }} icon="＋" />}{servers.map((server) => <div key={server.id} className={`app-list-row flex items-center gap-1 ${server.id === selectedId ? "is-selected" : ""}`}><button type="button" onClick={() => selectServer(server)} className="min-w-0 flex-1 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400"><span className="block truncate text-xs font-medium text-slate-200">{server.name}</span><span className={`mt-0.5 block text-[10px] ${server.enabled ? "text-emerald-400" : "text-slate-600"}`}>{server.enabled ? ut(locale, "enabled") : ut(locale, "disabled")}</span></button><button type="button" ref={(element) => { deleteButtonRefs.current[server.id] = element; }} onClick={() => { if (shouldConfirmDestructive()) setPendingDelete(server); else void doRemove(server); }} aria-label={ut(locale, "removeNamed", { name: server.name })} className="mr-1 rounded px-1.5 py-1 text-xs text-slate-600 hover:bg-red-950 hover:text-red-300">×</button></div>)}</div></aside>

        <div className="min-w-0 space-y-3"><section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-200">{ut(locale, "serverDefinition")}</h3><p className="mt-1 text-xs text-slate-500">{ut(locale, "serverDefinitionHint")}</p></div><label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-fuchsia-500" /> {ut(locale, "enabled")}</label></div><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs text-slate-400">{ut(locale, "fieldName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={ut(locale, "fieldNamePlaceholder")} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500 focus:outline-none" /></label><label className="text-xs text-slate-400">{ut(locale, "fieldCommand")}<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx or C:\\Tools\\server.exe" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500 focus:outline-none" /></label></div><label className="mt-3 block text-xs text-slate-400">{ut(locale, "fieldArgs")}<textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={4} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Documents"} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500 focus:outline-none" /></label><div className="mt-3 flex flex-wrap items-center gap-2"><label className="text-xs text-slate-400">{ut(locale, "approvalPolicy")}<select value={approvalPolicy} onChange={(event) => { setApprovalPolicy(event.target.value as McpApprovalPolicy); saveMcpApprovalPolicy(event.target.value as McpApprovalPolicy); setApprovedCalls(new Set()); }} className="ml-2 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"><option value="always-ask">{ut(locale, "policyAlwaysAsk")}</option><option value="once">{ut(locale, "policyOnce")}</option><option value="session">{ut(locale, "policySession")}</option><option value="server-tool">{ut(locale, "policyServerTool")}</option><option value="deny">{ut(locale, "policyDeny")}</option></select></label><button type="button" onClick={() => void save()} className="rounded-lg bg-fuchsia-600 px-3 py-2 text-xs font-medium text-white hover:bg-fuchsia-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400">{ut(locale, "saveServer")}</button>{selectedServer && <><code className="max-w-full truncate rounded bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-500" title={formatMcpCommand(selectedServer.command, selectedServer.args)}>{formatMcpCommand(selectedServer.command, selectedServer.args)}</code><button type="button" onClick={() => void discoverTools()} disabled={toolLoading || !selectedServer.enabled} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-40">{toolLoading ? ut(locale, "discovering") : ut(locale, "discoverTools")}</button></>}</div></section>

          {selectedServer && <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-200">{ut(locale, "toolsTitle")} {tools.length > 0 && <span className="text-fuchsia-300">· {tools.length}</span>}</h3><p className="mt-1 text-xs text-slate-500">{ut(locale, "toolsHint")}</p></div><span className="rounded bg-amber-950 px-2 py-1 text-[10px] text-amber-300">{ut(locale, "approvalRequiredBadge")}</span></div>{tools.length === 0 && <p className="mt-4 text-sm text-slate-600">{ut(locale, "discoverToolsHint")}</p>}<div className="mt-3 space-y-2">{tools.map((tool) => <div key={tool.name} className={`app-list-row p-3 ${selectedTool?.name === tool.name ? "is-selected" : "border-slate-800 bg-slate-950/50"}`}><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><code className="font-mono text-xs text-fuchsia-300">{tool.name}</code><p className="mt-1 text-xs leading-relaxed text-slate-500">{tool.description || ut(locale, "noToolDescription")}</p></div><button type="button" onClick={() => { setSelectedTool(tool); setArgsJson("{}\n"); setApproval(null); setResult(null); }} className="shrink-0 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700">{ut(locale, "prepareCall")}</button></div>{selectedTool?.name === tool.name && <div className="mt-3 border-t border-slate-800 pt-3"><label className="block text-xs text-slate-400">{ut(locale, "jsonArguments")}<textarea value={argsJson} onChange={(event) => setArgsJson(event.target.value)} rows={4} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-2.5 font-mono text-xs text-slate-200 focus:border-fuchsia-500 focus:outline-none" /></label><details className="mt-2"><summary className="cursor-pointer text-[11px] text-slate-600">{ut(locale, "inputSchema")}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-600">{JSON.stringify(tool.input_schema, null, 2)}</pre></details><button type="button" onClick={prepareCall} className="mt-3 rounded-lg border border-amber-700 bg-amber-950/60 px-3 py-2 text-xs text-amber-200 hover:bg-amber-900">{ut(locale, "reviewToolCall")}</button></div>}</div>)}</div></section>}

          {approval && selectedServer && <section className="rounded-xl border border-amber-600/70 bg-amber-950/30 p-4" role="alert"><h3 className="text-sm font-semibold text-amber-200">{ut(locale, "approveTitle")}</h3><p className="mt-1 text-xs leading-relaxed text-amber-300/80">{ut(locale, "approveBody", { tool: approval.tool.name, server: selectedServer.name })}</p><pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">{JSON.stringify(approval.args, null, 2)}</pre><div className="mt-3 flex gap-2"><button type="button" disabled={approvalBusy} onClick={() => void approveCall()} className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50">{approvalBusy ? ut(locale, "approveRunning") : ut(locale, "approveRun")}</button><button type="button" disabled={approvalBusy} onClick={() => setApproval(null)} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">{pt(locale, "cancel")}</button></div></section>}
          {result !== null && <section className="rounded-xl border border-emerald-800 bg-emerald-950/20 p-4"><h3 className="text-sm font-semibold text-emerald-300">{ut(locale, "toolResult")}</h3><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre></section>}
        </div>
      </div>

      <dialog
        ref={deleteDialogRef}
        className="app-confirm-dialog"
        aria-labelledby="mcp-delete-title"
        aria-describedby="mcp-delete-description"
        onCancel={(event) => { event.preventDefault(); closeDeleteDialog(); }}
      >
        <div className="app-confirm-dialog__panel">
          <div className="app-confirm-dialog__eyebrow">{ut(locale, "destructiveAction")}</div>
          <h2 id="mcp-delete-title">{ut(locale, "deleteServerTitle")}</h2>
          <p id="mcp-delete-description">
            {ut(locale, "deleteServerBody", { name: pendingDelete?.name ?? "" })}
          </p>
          <div className="app-confirm-dialog__actions">
            <button type="button" ref={cancelDeleteRef} className="app-button app-button--secondary" onClick={closeDeleteDialog}>{pt(locale, "cancel")}</button>
            <button type="button" className="app-button app-button--danger" onClick={() => pendingDelete && void doRemove(pendingDelete)}>{ut(locale, "deleteServer")}</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
