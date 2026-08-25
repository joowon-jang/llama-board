export interface McpServerDraft {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface McpFunctionIdentity {
  serverId: string;
  toolName: string;
}

export function validateMcpServerDraft(draft: McpServerDraft): string | null {
  const name = draft.name.trim();
  const command = draft.command.trim();
  if (!name || name.length > 80) return "A server name between 1 and 80 characters is required.";
  if (!command || command.length > 512 || /[\u0000\r\n]/.test(command) || /[&|;<>]/.test(command)) return "The command must be one executable name/path; shell operators are not allowed.";
  if (draft.args.length > 64 || draft.args.some((arg) => arg.length > 4096 || /[\u0000\r\n]/.test(arg))) return "Arguments must be at most 64 newline-free values.";
  return null;
}

export function formatMcpCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export function mcpFunctionName(serverId: string, toolName: string): string {
  return `${serverId}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
}

export function buildMcpFunctionNames(entries: McpFunctionIdentity[]): string[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    const base = mcpFunctionName(entry.serverId, entry.toolName);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      const marker = `_${suffix++}`;
      candidate = `${base.slice(0, 96 - marker.length)}${marker}`;
    }
    used.add(candidate);
    return candidate;
  });
}

export function requiresToolApproval(_autoApprove: boolean): boolean {
  return true;
}
