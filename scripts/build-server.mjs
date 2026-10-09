// scripts/build-server.mjs
// Bundles BOTH the VS Code extension (CJS) and the MCP RAG server (ESM)
// Also builds the Brain HQ React webview-ui if present
import { execSync } from "child_process";
import { build } from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ─── 1. Bundle the VS Code extension (CJS) ──────────────────────────────────
// This inlines all dependencies (glob, gray-matter, etc.) so node_modules
// does NOT need to ship inside the VSIX.
async function bundleExtension() {
  console.log("📦 Bundling extension...");
  // Crash diagnostic banner — runs FIRST in the bundle, before any module code
  const crashBanner = `
var _pb_fs=require("fs"),_pb_os=require("os"),_pb_path=require("path");
var _pb_crashLog=_pb_path.join(_pb_os.tmpdir(),"project-brain-crash.log");
function _pb_diag(l,e){var m=e instanceof Error?e.message+"\\n"+e.stack:String(e);try{_pb_fs.appendFileSync(_pb_crashLog,"["+new Date().toISOString()+"] "+l+": "+m+"\\n")}catch(_){}console.error("[PB-CRASH] "+l+":",e)}
process.on("uncaughtException",function(e){_pb_diag("uncaughtException",e)});
process.on("unhandledRejection",function(e){_pb_diag("unhandledRejection",e)});
`;
  await build({
    entryPoints: [path.join(ROOT, "src", "extension.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    outfile: path.join(ROOT, "dist", "extension.js"),
    sourcemap: true,
    minify: true,
    external: ["vscode"], // vscode = host runtime; sql.js is bundled (WASM copied separately)
    banner: { js: crashBanner },
  });

  // Copy sql-wasm.wasm into dist/ so it ships alongside the bundled extension
  const wasmSrc = path.join(
    ROOT,
    "node_modules",
    "sql.js",
    "dist",
    "sql-wasm.wasm",
  );
  const wasmDest = path.join(ROOT, "dist", "sql-wasm.wasm");
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, wasmDest);
    console.log("✅ WASM copied → dist/sql-wasm.wasm");
  } else {
    console.warn("⚠️  sql-wasm.wasm not found at", wasmSrc);
  }

  console.log("✅ Extension bundled → dist/extension.js");
}

// ─── 2. Bundle the MCP RAG server (ESM) ─────────────────────────────────────

// Try to locate the MCP server source
// Priority order: local → relative → env var → home directory
// ─── 3. Bundle the Agent Orchestrator (ESM) ────────────────────────────────
const homeDir = process.env.HOME || process.env.USERPROFILE || "";

const orchestratorCandidates = [
  path.join(ROOT, "server-orchestrator", "src"),
  ...(homeDir
    ? [path.join(homeDir, "mcp-servers", "agent-orchestrator", "src")]
    : []),
];

let orchestratorSrc = null;
for (const candidate of orchestratorCandidates) {
  if (fs.existsSync(path.join(candidate, "index.ts"))) {
    orchestratorSrc = candidate;
    break;
  }
}

const candidates = [
  path.join(ROOT, "server", "src"), // local copy in extension repo
  path.resolve(ROOT, "..", "..", "mcp-servers", "rag-docs", "src"), // relative to extensions dir
  // User-specified path via environment variable (CI/CD friendly)
  ...(process.env.MCP_SERVER_SRC ? [process.env.MCP_SERVER_SRC] : []),
  // Home directory fallback
  ...(homeDir ? [path.join(homeDir, "mcp-servers", "rag-docs", "src")] : []),
];

let serverSrc = null;
for (const candidate of candidates) {
  if (fs.existsSync(path.join(candidate, "index.ts"))) {
    serverSrc = candidate;
    break;
  }
}

if (!serverSrc) {
  console.warn(
    "⚠️  MCP server source not found. Skipping server bundle.\n" +
      "   Searched:",
    candidates.join(", "),
  );
  // Don't exit — still need to bundle the extension
}

console.log(`📦 Bundling MCP server from: ${serverSrc}`);

const outdir = path.join(ROOT, "dist", "mcp-server");

const sharedOptions = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir,
  sourcemap: false,
  minify: false,
  // Mark only built-in Node modules as external (everything else gets bundled)
  external: [],
  // Handle __dirname / __filename for ESM
  banner: {
    js: `import{createRequire as __cr}from"module";import{fileURLToPath as __fu}from"url";import{dirname as __dn}from"path";const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);const require=__cr(import.meta.url);`,
  },
};

async function run() {
  try {
    // Build React webview-ui (Brain HQ) if present
    const webviewUiDir = path.join(ROOT, "webview-ui");
    if (fs.existsSync(path.join(webviewUiDir, "package.json"))) {
      console.log("📦 Building Brain HQ webview-ui (React + Vite)...");
      // Install deps if node_modules missing
      if (!fs.existsSync(path.join(webviewUiDir, "node_modules"))) {
        console.log("   Installing webview-ui dependencies...");
        execSync("npm install", { cwd: webviewUiDir, stdio: "inherit" });
      }
      execSync("npx vite build", { cwd: webviewUiDir, stdio: "inherit" });
      console.log("✅ Webview-ui built → dist/webview-ui/");
    }

    // Always bundle the extension
    await bundleExtension();

    // Bundle MCP server if source is available
    if (serverSrc) {
      await build({
        ...sharedOptions,
        entryPoints: [path.join(serverSrc, "index.ts")],
        outExtension: { ".js": ".mjs" },
      });

      await build({
        ...sharedOptions,
        entryPoints: [path.join(serverSrc, "cli.ts")],
        outExtension: { ".js": ".mjs" },
      });

      console.log("✅ MCP server bundled → dist/mcp-server/");
    }

    // Bundle Agent Orchestrator if source is available
    if (orchestratorSrc) {
      const orchOutdir = path.join(ROOT, "dist", "agent-orchestrator");
      await build({
        ...sharedOptions,
        entryPoints: [path.join(orchestratorSrc, "index.ts")],
        outdir: orchOutdir,
        outExtension: { ".js": ".mjs" },
      });
      console.log("✅ Agent Orchestrator bundled → dist/agent-orchestrator/");
    } else {
      console.warn(
        "⚠️  Agent Orchestrator source not found — skipping bundle.",
      );
      console.warn("   Searched:", orchestratorCandidates.join(", "));
    }
  } catch (error) {
    console.error("❌ Bundle failed:", error);
    process.exit(1);
  }
}

run();
