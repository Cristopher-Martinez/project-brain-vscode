/**
 * E2E test — Multilingual semantic capture (Fase B) against the LIVE
 * production embedding gateway (api.projectbrain.tech/api/v1).
 *
 * Feeds German + French "learning"-shaped sentences that the lexical (regex)
 * gate cannot catch, forcing the semantic slow-path. Verifies mode === "semantic".
 *
 * Run via: node scripts/test-semantic-prod.mjs (bundled by build-test-semantic.mjs)
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLearningHybrid } from "../server/src/semantic-capture.js";

async function main(): Promise<void> {
  // Force the remote provider at the live production gateway.
  process.env.EMBEDDING_BASE_URL =
    process.env.EMBEDDING_BASE_URL || "https://api.projectbrain.tech/api/v1";
  process.env.EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "community";

  const dir = mkdtempSync(join(tmpdir(), "pb-sem-"));
  writeFileSync(join(dir, "14_OPINIONS.md"), "# Opinions\n\n");

  // Multilingual sentences shaped like learnings, but NOT matching English regex
  // anchors — forcing the semantic slow-path across 6 languages.
  const samples: Array<{ lang: string; text: string }> = [
    {
      lang: "DE",
      text:
        "Die eigentliche Ursache war ein veralteter Cache, der nach jedem Build geleert werden muss.",
    },
    {
      lang: "FR",
      text:
        "La cause racine etait une configuration obsolete; il faut toujours invalider le cache apres le deploiement.",
    },
    {
      lang: "ES",
      text:
        "Aprendimos que el servicio debe reiniciarse para que las variables de entorno surtan efecto.",
    },
    {
      lang: "IT",
      text:
        "La causa principale era una cache obsoleta che deve essere svuotata dopo ogni compilazione.",
    },
    {
      lang: "PT",
      text:
        "A licao aprendida foi que o token Bearer precisa ser aceito alem do cabecalho x-api-key.",
    },
    {
      lang: "NL",
      text:
        "We hebben geleerd dat de proxy de Authorization-header moet doorsturen naar de backend.",
    },
  ];

  let semanticCount = 0;
  for (const s of samples) {
    const res = await captureLearningHybrid(dir, s.text, `e2e-${s.lang}`);
    const flag = res.mode === "semantic" ? "✅" : res.mode === "lexical" ? "📐" : "⚪";
    console.log(
      `${flag} [${s.lang}] mode=${res.mode} captured=${res.captured} :: ${s.text.slice(0, 60)}...`,
    );
    if (res.mode === "semantic") semanticCount++;
  }

  const opinionsPath = join(dir, "14_OPINIONS.md");
  if (existsSync(opinionsPath)) {
    const body = readFileSync(opinionsPath, "utf8");
    const lines = body.split("\n").filter((l) => l.trim().startsWith("-") || l.includes("statement"));
    console.log(`\n📂 14_OPINIONS.md (${body.length} chars)`);
    console.log(body.slice(0, 600));
  }

  console.log(
    `\n${semanticCount > 0 ? "🏴‍☠️ PUERTO SEGURO" : "⛈️ TORMENTA"} — semantic captures: ${semanticCount}/${samples.length}`,
  );
  process.exit(semanticCount > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ ERROR:", err);
  process.exit(2);
});
