import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { formatMcpCommand, validateMcpServerDraft } from "../mcpUtils";
import FeedbackBanner from "../components/FeedbackBanner";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import { CustomSelect } from "../components/ThemeSwitcher";
import { useI18n } from "../i18n";
import type { UiTextKey } from "../uiI18n";
import { shouldConfirmDestructive } from "../preferences";
import { approvalKey, canAutoApprove, loadMcpApprovalPolicy, normalizeDisplayPath, normalizeDisplayPathLines, normalizeDisplayText, saveMcpApprovalPolicy, type McpApprovalPolicy } from "../lifecycleUtils";


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
  const { t } = useI18n();
  const policyLabel = (policy: McpApprovalPolicy) => t(`ui.${POLICY_LABELS[policy]}`);

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
      setNotice(t("ui.mcpSaved"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const doRemove = async (server: api.McpServer) => {
    try {
      setServers(await api.mcpRemoveServer(server.id));
      if (selectedId === server.id) resetDraft();
      setNotice(t("ui.mcpRemoved"));
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
      setNotice(t("ui.mcpToolsLoaded"));
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
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("ui.mcpArgsObject"));
      parsedArgs = parsed as Record<string, unknown>;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("ui.mcpArgsInvalid"));
      return;
    }
    setError(null);
    setResult(null);
    if (approvalPolicy === "deny") {
      setError(t("ui.mcpBlockedByPolicy"));
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
        ? `${t("ui.mcpAutoApproved", { policy: policyLabel(approvalPolicy) })} ${t("ui.mcpToolCompleted", { name: pending.tool.name })}`
        : t("ui.mcpToolCompleted", { name: pending.tool.name }));
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
  const displayMcpCommand = selectedServer
    ? formatMcpCommand(normalizeDisplayText(selectedServer.command), selectedServer.args.map(normalizeDisplayText))
    : "";

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-4"><h2 className="text-xl font-semibold tracking-tight text-slate-100">{t("section.mcp")}</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-500">{t("ui.mcpIntro")}</p></div>
      <div className="mb-4 rounded-lg border border-amber-800 bg-amber-950/30 px-3.5 py-2.5 text-xs leading-relaxed text-amber-200">{t("ui.mcpWarning")}</div>
      <div className="mb-4 grid gap-3 sm:grid-cols-3" role="group" aria-label={t("panel.ariaConfiguredServers")}>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{t("ui.mcpServersCount")}</div><div className="mt-1 text-sm font-medium text-slate-200">{t("ui.mcpConfigured", { count: servers.length })}</div></div>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{t("ui.enabled")}</div><div className="mt-1"><StatusBadge label={t("ui.mcpEnabledCount", { count: servers.filter((server) => server.enabled).length })} tone={servers.some((server) => server.enabled) ? "success" : "neutral"} /></div></div>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{t("ui.mcpApproval")}</div><div className="mt-1 text-sm font-medium text-amber-300">{policyLabel(approvalPolicy)}</div></div>
      </div>
      <div className="app-panel-feedback-layer" aria-live="polite">
        {error && <FeedbackBanner tone="error" title={t("panel.mcpActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </div>

      <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)]">
        <aside className="rounded-xl border border-slate-800 bg-slate-900/50 p-3"><div className="flex items-center justify-between gap-2"><h3 className="app-section-title">{t("panel.configuredServers")}</h3><button type="button" onClick={resetDraft} className="app-button app-button--secondary app-button--sm">{t("panel.newItem")}</button></div><div className="mt-3 space-y-1.5">{servers.length === 0 && <EmptyState title={t("panel.noMcpServers")} description={t("ui.mcpEmptyHint")} action={{ label: t("panel.newItem"), onClick: resetDraft }} icon="＋" />}{servers.map((server) => <div key={server.id} className={`app-list-row flex items-center justify-between gap-1 px-1 py-1 ${server.id === selectedId ? "is-selected" : ""}`}><button type="button" onClick={() => selectServer(server)} className="min-w-0 flex-1 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400"><span className="block truncate text-xs font-medium text-slate-200">{server.name}</span><span className={`mt-0.5 block text-[10px] ${server.enabled ? "text-emerald-400" : "text-slate-600"}`}>{server.enabled ? t("ui.enabled") : t("ui.disabled")}</span></button><button type="button" ref={(element) => { deleteButtonRefs.current[server.id] = element; }} onClick={() => { if (shouldConfirmDestructive()) setPendingDelete(server); else void doRemove(server); }} aria-label={t("ui.removeNamed", { name: server.name })} className="app-icon-button app-icon-button--danger mr-1">×</button></div>)}</div></aside>

        <div className="min-w-0 space-y-4"><section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="app-section-title">{t("ui.serverDefinition")}</h3><p className="app-section-hint">{t("ui.serverDefinitionHint")}</p></div><label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-fuchsia-500" /> {t("ui.enabled")}</label></div><div className="mt-3.5 grid gap-3 md:grid-cols-2"><label className="text-xs text-slate-400">{t("ui.fieldName")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("ui.fieldNamePlaceholder")} className="app-input mt-1" /></label><label className="text-xs text-slate-400">{t("ui.fieldCommand")}<input value={normalizeDisplayPath(command)} onChange={(event) => setCommand(event.target.value)} placeholder="npx or C:\\Tools\\server.exe" className="app-input mt-1 font-mono" /></label></div><label className="mt-3.5 block text-xs text-slate-400">{t("ui.fieldArgs")}<textarea value={normalizeDisplayPathLines(argsText)} onChange={(event) => setArgsText(event.target.value)} rows={4} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Documents"} className="app-textarea mt-1 app-mono" /></label><div className="mt-4 flex flex-wrap items-center gap-2.5"><div className="flex items-center gap-2 text-xs text-slate-400"><span>{t("ui.approvalPolicy")}</span><CustomSelect value={approvalPolicy} options={[{ value: "always-ask", label: t("ui.policyAlwaysAsk") }, { value: "once", label: t("ui.policyOnce") }, { value: "session", label: t("ui.policySession") }, { value: "server-tool", label: t("ui.policyServerTool") }, { value: "deny", label: t("ui.policyDeny") }]} onChange={(val) => { setApprovalPolicy(val as McpApprovalPolicy); saveMcpApprovalPolicy(val as McpApprovalPolicy); setApprovedCalls(new Set()); }} size="sm" triggerClassName="w-[140px]" /></div><button type="button" onClick={() => void save()} className="app-button app-button--primary app-button--sm">{t("ui.saveServer")}</button>{selectedServer && <><code className="max-w-full truncate rounded bg-slate-950 px-2.5 py-1.5 font-mono text-[11px] text-slate-500" title={displayMcpCommand}>{displayMcpCommand}</code><button type="button" onClick={() => void discoverTools()} disabled={toolLoading || !selectedServer.enabled} className="app-button app-button--secondary app-button--sm">{toolLoading ? t("ui.discovering") : t("ui.discoverTools")}</button></>}</div></section>

          {selectedServer && <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="app-section-title">{t("ui.toolsTitle")} {tools.length > 0 && <span className="text-fuchsia-300">· {tools.length}</span>}</h3><p className="app-section-hint">{t("ui.toolsHint")}</p></div><span className="rounded bg-amber-950 px-2.5 py-1 text-[10px] text-amber-300">{t("ui.approvalRequiredBadge")}</span></div>{tools.length === 0 && <p className="mt-4 text-sm text-slate-600">{t("ui.discoverToolsHint")}</p>}<div className="mt-3.5 space-y-2.5">{tools.map((tool) => <div key={tool.name} className={`app-list-row p-3.5 ${selectedTool?.name === tool.name ? "is-selected" : "border-slate-800 bg-slate-950/50"}`}><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><code className="font-mono text-xs text-fuchsia-300">{tool.name}</code><p className="mt-1 text-xs leading-relaxed text-slate-500">{normalizeDisplayText(tool.description || t("ui.noToolDescription"))}</p></div><button type="button" onClick={() => { setSelectedTool(tool); setArgsJson("{}\n"); setApproval(null); setResult(null); }} className="app-button app-button--secondary app-button--sm">{t("ui.prepareCall")}</button></div>{selectedTool?.name === tool.name && <div className="mt-3.5 border-t border-slate-800 pt-3.5"><label className="block text-xs text-slate-400">{t("ui.jsonArguments")}<textarea value={normalizeDisplayText(argsJson)} onChange={(event) => setArgsJson(event.target.value)} rows={4} className="app-textarea mt-1 app-mono" /></label><details className="mt-2.5"><summary className="cursor-pointer text-[11px] text-slate-600">{t("ui.inputSchema")}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-600">{normalizeDisplayText(JSON.stringify(tool.input_schema, null, 2))}</pre></details><button type="button" onClick={prepareCall} className="app-button app-button--primary app-button--sm mt-3.5">{t("ui.reviewToolCall")}</button></div>}</div>)}</div></section>}

          {approval && selectedServer && <section className="rounded-xl border border-amber-600 bg-amber-950/30 p-4" role="alert"><h3 className="app-section-title text-amber-200">{t("ui.approveTitle")}</h3><p className="app-section-hint text-amber-300/80">{t("ui.approveBody", { tool: approval.tool.name, server: selectedServer.name })}</p><pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">{normalizeDisplayText(JSON.stringify(approval.args, null, 2))}</pre><div className="mt-3.5 flex gap-2"><button type="button" disabled={approvalBusy} onClick={() => void approveCall()} className="app-button app-button--primary app-button--sm">{approvalBusy ? t("ui.approveRunning") : t("ui.approveRun")}</button><button type="button" disabled={approvalBusy} onClick={() => setApproval(null)} className="app-button app-button--secondary app-button--sm">{t("panel.cancel")}</button></div></section>}
          {result !== null && <section className="rounded-xl border app-border-success bg-emerald-950/20 p-4"><h3 className="app-section-title text-emerald-300">{t("ui.toolResult")}</h3><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">{normalizeDisplayText(typeof result === "string" ? result : JSON.stringify(result, null, 2))}</pre></section>}
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
          <div className="app-confirm-dialog__eyebrow">{t("ui.destructiveAction")}</div>
          <h2 id="mcp-delete-title">{t("ui.deleteServerTitle")}</h2>
          <p id="mcp-delete-description">
            {t("ui.deleteServerBody", { name: pendingDelete?.name ?? "" })}
          </p>
          <div className="app-confirm-dialog__actions">
            <button type="button" ref={cancelDeleteRef} className="app-button app-button--secondary" onClick={closeDeleteDialog}>{t("panel.cancel")}</button>
            <button type="button" className="app-button app-button--danger" onClick={() => pendingDelete && void doRemove(pendingDelete)}>{t("ui.deleteServer")}</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
