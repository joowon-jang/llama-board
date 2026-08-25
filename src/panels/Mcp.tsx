import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { formatMcpCommand, validateMcpServerDraft } from "../mcpUtils";

type Approval = { tool: api.McpTool; args: Record<string, unknown> };

function newId() {
  return `mcp-${Date.now().toString(36)}`;
}

export default function McpPanel(_props: { store: AppStore }) {
  const [servers, setServers] = useState<api.McpServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [enabled, setEnabled] = useState(true);
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
      setNotice("MCP server saved. Tool discovery starts only when you request it.");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const remove = async (server: api.McpServer) => {
    try {
      setServers(await api.mcpRemoveServer(server.id));
      if (selectedId === server.id) resetDraft();
      setNotice("MCP server removed.");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const discoverTools = async () => {
    if (!selectedId) return;
    setToolLoading(true);
    setError(null);
    setNotice(null);
    try {
      setTools(await api.mcpListTools(selectedId));
      setNotice("Tool metadata loaded. No tool has been called.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setToolLoading(false);
    }
  };

  const prepareCall = () => {
    if (!selectedTool) return;
    try {
      const parsed = JSON.parse(argsJson) as unknown;
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Arguments must be a JSON object.");
      setApproval({ tool: selectedTool, args: parsed as Record<string, unknown> });
      setError(null);
      setResult(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Arguments must be valid JSON.");
    }
  };

  const approveCall = async () => {
    if (!selectedId || !approval || approvalBusyRef.current) return;
    const pending = approval;
    const serverId = selectedId;
    approvalBusyRef.current = true;
    setApprovalBusy(true);
    setApproval(null);
    try {
      setResult(await api.mcpCallTool(serverId, pending.tool.name, pending.args));
      setNotice(`Tool ${pending.tool.name} completed.`);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      approvalBusyRef.current = false;
      setApprovalBusy(false);
    }
  };

  const selectedServer = servers.find((server) => server.id === selectedId);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3 sm:p-4">
      <div className="mb-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-300">Tools</div><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">MCP servers</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-500">Connect trusted Model Context Protocol servers over stdio. Servers run as child processes with direct argv arguments; no shell is involved. Tool calls always require a separate approval click.</p></div>
      <div className="mb-3 rounded-lg border border-amber-800/80 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-200">Only add servers you trust. An MCP server can read files, access the network, or modify data according to its own process permissions. Do not enter secrets: server definitions and arguments are stored in local app configuration.</div>
      {error && <div className="mb-3 break-words rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">{error}</div>}
      {notice && <div className="mb-3 rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200" role="status">{notice}</div>}

      <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(13rem,0.35fr)_minmax(0,1fr)]">
        <aside className="rounded-xl border border-slate-800 bg-slate-900/50 p-3"><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-200">Configured servers</h3><button type="button" onClick={resetDraft} className="rounded bg-fuchsia-950/70 px-2 py-1 text-[11px] text-fuchsia-200 hover:bg-fuchsia-900">New</button></div><div className="mt-3 space-y-1.5">{servers.length === 0 && <p className="px-2 py-3 text-xs text-slate-600">No MCP servers yet.</p>}{servers.map((server) => <div key={server.id} className={`flex items-center gap-1 rounded-lg border ${server.id === selectedId ? "border-fuchsia-500/50 bg-fuchsia-500/10" : "border-transparent hover:bg-slate-800"}`}><button type="button" onClick={() => selectServer(server)} className="min-w-0 flex-1 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400"><span className="block truncate text-xs font-medium text-slate-200">{server.name}</span><span className={`mt-0.5 block text-[10px] ${server.enabled ? "text-emerald-400" : "text-slate-600"}`}>{server.enabled ? "Enabled" : "Disabled"}</span></button><button type="button" onClick={() => void remove(server)} aria-label={`Remove ${server.name}`} className="mr-1 rounded px-1.5 py-1 text-xs text-slate-600 hover:bg-red-950 hover:text-red-300">×</button></div>)}</div></aside>

        <div className="min-w-0 space-y-3"><section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-200">Server definition</h3><p className="mt-1 text-xs text-slate-500">Arguments are entered one per line and passed directly to the executable.</p></div><label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-fuchsia-500" /> Enabled</label></div><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs text-slate-400">Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Filesystem tools" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500 focus:outline-none" /></label><label className="text-xs text-slate-400">Executable / command<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx or C:\\Tools\\server.exe" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500 focus:outline-none" /></label></div><label className="mt-3 block text-xs text-slate-400">Arguments, one per line<textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={4} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Documents"} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-fuchsia-500 focus:outline-none" /></label><div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" onClick={() => void save()} className="rounded-lg bg-fuchsia-600 px-3 py-2 text-xs font-medium text-white hover:bg-fuchsia-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400">Save server</button>{selectedServer && <><code className="max-w-full truncate rounded bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-500" title={formatMcpCommand(selectedServer.command, selectedServer.args)}>{formatMcpCommand(selectedServer.command, selectedServer.args)}</code><button type="button" onClick={() => void discoverTools()} disabled={toolLoading || !selectedServer.enabled} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-40">{toolLoading ? "Discovering…" : "Discover tools"}</button></>}</div></section>

          {selectedServer && <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-200">Tools {tools.length > 0 && <span className="text-fuchsia-300">· {tools.length}</span>}</h3><p className="mt-1 text-xs text-slate-500">Discovery starts a fresh stdio session and closes it after the response.</p></div><span className="rounded bg-amber-950 px-2 py-1 text-[10px] text-amber-300">approval required</span></div>{tools.length === 0 && <p className="mt-4 text-sm text-slate-600">Click Discover tools to inspect this server.</p>}<div className="mt-3 space-y-2">{tools.map((tool) => <div key={tool.name} className={`rounded-lg border p-3 ${selectedTool?.name === tool.name ? "border-fuchsia-500/50 bg-fuchsia-500/5" : "border-slate-800 bg-slate-950/50"}`}><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><code className="font-mono text-xs text-fuchsia-300">{tool.name}</code><p className="mt-1 text-xs leading-relaxed text-slate-500">{tool.description || "No description supplied."}</p></div><button type="button" onClick={() => { setSelectedTool(tool); setArgsJson("{}\n"); setApproval(null); setResult(null); }} className="shrink-0 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700">Prepare call</button></div>{selectedTool?.name === tool.name && <div className="mt-3 border-t border-slate-800 pt-3"><label className="block text-xs text-slate-400">JSON arguments<textarea value={argsJson} onChange={(event) => setArgsJson(event.target.value)} rows={4} className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-2.5 font-mono text-xs text-slate-200 focus:border-fuchsia-500 focus:outline-none" /></label><details className="mt-2"><summary className="cursor-pointer text-[11px] text-slate-600">Input schema</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-600">{JSON.stringify(tool.input_schema, null, 2)}</pre></details><button type="button" onClick={prepareCall} className="mt-3 rounded-lg border border-amber-700 bg-amber-950/60 px-3 py-2 text-xs text-amber-200 hover:bg-amber-900">Review tool call</button></div>}</div>)}</div></section>}

          {approval && selectedServer && <section className="rounded-xl border border-amber-600/70 bg-amber-950/30 p-4" role="alert"><h3 className="text-sm font-semibold text-amber-200">Approve one tool call?</h3><p className="mt-1 text-xs leading-relaxed text-amber-300/80">This will run <code className="font-mono">{approval.tool.name}</code> on <strong>{selectedServer.name}</strong> with the JSON below. Review the arguments before approving.</p><pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">{JSON.stringify(approval.args, null, 2)}</pre><div className="mt-3 flex gap-2"><button type="button" disabled={approvalBusy} onClick={() => void approveCall()} className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50">{approvalBusy ? "Running…" : "Approve and run once"}</button><button type="button" disabled={approvalBusy} onClick={() => setApproval(null)} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">Cancel</button></div></section>}
          {result !== null && <section className="rounded-xl border border-emerald-800 bg-emerald-950/20 p-4"><h3 className="text-sm font-semibold text-emerald-300">Tool result</h3><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre></section>}
        </div>
      </div>
    </div>
  );
}
