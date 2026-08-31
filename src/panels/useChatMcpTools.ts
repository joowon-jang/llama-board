import { useState } from "react";
import * as api from "../api";
import { buildMcpFunctionNames } from "../mcpUtils";

export interface ChatMcpTool {
  serverId: string;
  serverName: string;
  tool: api.McpTool;
}

interface UseChatMcpToolsOptions {
  /** Mirrors the panel's shared error banner: pass a message to show it, `null` to clear it. */
  setError: (message: string | null) => void;
}

export function useChatMcpTools({ setError }: UseChatMcpToolsOptions) {
  const [mcpCatalog, setMcpCatalog] = useState<ChatMcpTool[]>([]);
  const [selectedMcpTools, setSelectedMcpTools] = useState<string[]>([]);
  const [loadingMcpTools, setLoadingMcpTools] = useState(false);

  const refreshMcpTools = async () => {
    if (loadingMcpTools) return;
    setLoadingMcpTools(true);
    try {
      const servers = await api.mcpListServers();
      const entries: ChatMcpTool[] = [];
      for (const server of servers.filter((item) => item.enabled)) {
        const tools = await api.mcpListTools(server.id);
        entries.push(...tools.map((tool) => ({ serverId: server.id, serverName: server.name, tool })));
      }
      setMcpCatalog(entries);
      setSelectedMcpTools(entries.map((entry) => `${entry.serverId}:${entry.tool.name}`));
      setError(null);
    } catch (caught) {
      setError(`MCP tool discovery failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setLoadingMcpTools(false);
    }
  };

  const toggleMcpTool = (key: string) => {
    setSelectedMcpTools((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  const selectedMcpEntries = mcpCatalog.filter((entry) => selectedMcpTools.includes(`${entry.serverId}:${entry.tool.name}`));
  const generatedMcpNames = buildMcpFunctionNames(selectedMcpEntries.map((entry) => ({ serverId: entry.serverId, toolName: entry.tool.name })));
  const mcpEntryByFunctionName = new Map(generatedMcpNames.map((name, index) => [name, selectedMcpEntries[index]]));
  const mcpDefinitions: api.ChatToolDefinition[] = selectedMcpEntries.map((entry, index) => ({
    type: "function",
    function: {
      name: generatedMcpNames[index],
      description: entry.tool.description,
      parameters: entry.tool.input_schema && typeof entry.tool.input_schema === "object"
        ? entry.tool.input_schema
        : { type: "object", properties: {} },
    },
  }));

  return {
    mcpCatalog, selectedMcpTools, setSelectedMcpTools, loadingMcpTools,
    refreshMcpTools, toggleMcpTool, mcpEntryByFunctionName, mcpDefinitions,
  };
}
