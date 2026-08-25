import assert from "node:assert/strict";
import { buildMcpFunctionNames, formatMcpCommand, requiresToolApproval, validateMcpServerDraft } from "../src/mcpUtils.ts";

assert.equal(validateMcpServerDraft({ name: "Filesystem", command: "npx", args: ["-y", "server"], enabled: true }), null);
assert.match(validateMcpServerDraft({ name: "", command: "npx", args: [], enabled: true }) ?? "", /name/i);
assert.match(validateMcpServerDraft({ name: "Server", command: "npx && whoami", args: [], enabled: true }) ?? "", /command/i);
assert.equal(formatMcpCommand("npx", ["-y", "server"]), "npx -y server");
assert.equal(requiresToolApproval(false), true);
assert.equal(requiresToolApproval(true), true);
const longPrefix = "s".repeat(80);
const names = buildMcpFunctionNames([
  { serverId: longPrefix, toolName: `${"a".repeat(30)}-one` },
  { serverId: longPrefix, toolName: `${"a".repeat(30)}-two` },
]);
assert.equal(names.length, 2);
assert.notEqual(names[0], names[1]);
assert.ok(names.every((name) => name.length <= 96));
console.log("mcp utility tests passed");
