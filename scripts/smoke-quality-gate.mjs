// scripts/smoke-quality-gate.mjs
// Smoke test: spin up the bundled MCP server over stdio and call run_quality_gate.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERVER = join(ROOT, "dist", "mcp-server", "index.mjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, PROJECT_PATH: ROOT },
});

const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
const hasGate = tools.tools.some((t) => t.name === "run_quality_gate");
console.log(`run_quality_gate listed: ${hasGate ? "YES" : "NO"}`);

async function call(command) {
  const res = await client.callTool({ name: "run_quality_gate", arguments: { command } });
  const payload = JSON.parse(res.content[0].text);
  console.log(`cmd=${JSON.stringify(command)} -> decision=${payload.decision} matched=${payload.verdicts[0]?.matched ?? "-"}`);
  return payload;
}

const deny = await call("rm -rf /tmp/data");
const allow = await call("npm run compile");

await client.close();

const ok = hasGate && deny.decision === "deny" && allow.decision === "allow";
console.log(ok ? "\nSMOKE TEST PASSED" : "\nSMOKE TEST FAILED");
process.exit(ok ? 0 : 1);
