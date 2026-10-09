// Smoke test: call validate_capture on the bundled MCP server via stdio JSON-RPC.
// Proves a non-VS-Code client can reach the portable quality gate.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as fs from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "mcp-server", "index.mjs");

const proc = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* non-json log line */ }
  }
});

function send(id, method, params) {
  return new Promise((res) => {
    pending.set(id, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function run() {
  await send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const cases = [
    "Aprendí que validar inputs temprano evita bugs downstream porque el sistema falla cuando los datos llegan sucios.",
    "ok done next",
    "Updated. Listo.",
  ];

  for (let i = 0; i < cases.length; i++) {
    const resp = await send(10 + i, "tools/call", {
      name: "validate_capture",
      arguments: { text: cases[i] },
    });
    const text = resp.result?.content?.[0]?.text ?? JSON.stringify(resp.error);
    console.log(`CASE ${i + 1}: ${JSON.stringify(cases[i].slice(0, 40))} → ${text}`);
  }

  // Diary round-trip (uses this repo as the project)
  const projectPath = join(__dirname, "..");
  const wResp = await send(20, "tools/call", {
    name: "write_diary",
    arguments: {
      projectPath,
      mode: "researcher",
      title: "Smoke test entry",
      context: "Roadmap B vertical slice",
      learning: "The portable diary tool works from a non-VS-Code MCP client.",
      confidence: "high",
    },
  });
  console.log(`WRITE_DIARY → ${wResp.result?.content?.[0]?.text ?? JSON.stringify(wResp.error)}`);

  const rResp = await send(21, "tools/call", {
    name: "read_diary",
    arguments: { projectPath, mode: "researcher" },
  });
  const rText = rResp.result?.content?.[0]?.text ?? JSON.stringify(rResp.error);
  console.log(`READ_DIARY → ${rText.includes("Smoke test entry") ? "OK (entry found)" : "MISSING ENTRY:\n" + rText.slice(0, 200)}`);

  // Capture learning round-trip (writes to a throwaway temp project)
  const tmpProject = join(__dirname, "..", ".smoke-tmp");
  fs.mkdirSync(join(tmpProject, ".project-brain", "memory"), { recursive: true });
  const capResp = await send(30, "tools/call", {
    name: "capture_learning",
    arguments: {
      projectPath: tmpProject,
      text: "Aprendí que validar inputs temprano evita errores en cascada. La solución fue cachear el resultado del parser.",
      source: "smoke",
    },
  });
  console.log(`CAPTURE_LEARNING → ${capResp.result?.content?.[0]?.text ?? JSON.stringify(capResp.error)}`);

  const loResp = await send(31, "tools/call", {
    name: "list_opinions",
    arguments: { projectPath: tmpProject },
  });
  const loText = loResp.result?.content?.[0]?.text ?? JSON.stringify(loResp.error);
  console.log(`LIST_OPINIONS → ${loText.length > 2 ? "OK (" + (JSON.parse(loText).length) + " opinions)" : "EMPTY"}`);

  const reResp = await send(32, "tools/call", {
    name: "reflect_opinions",
    arguments: { projectPath: tmpProject, dryRun: true },
  });
  console.log(`REFLECT_OPINIONS (dryRun) → ${reResp.result?.content?.[0]?.text ?? JSON.stringify(reResp.error)}`);

  fs.rmSync(tmpProject, { recursive: true, force: true });

  proc.kill();
  process.exit(0);
}

run().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
