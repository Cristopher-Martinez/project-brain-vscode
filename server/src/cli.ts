#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { formatSearchResults, searchDocuments } from "./search.js";
import { getProjectId, listProjects, loadIndex } from "./storage.js";
import { vectorizeProject } from "./vectorize.js";
import { startWatching } from "./watcher.js";

const program = new Command();

program
  .name("rag-docs")
  .description("RAG documentation indexer and search")
  .version("2.1.0");

program
  .command("vectorize")
  .description("Index a project documentation folder")
  .argument("<projectPath>", "Path to the project root")
  .option("-f, --force", "Force complete re-indexing", false)
  .option(
    "--scan-all",
    "Scan all .md files from project root if no memory folder found",
    false,
  )
  .action(
    async (
      projectPath: string,
      options: { force: boolean; scanAll: boolean },
    ) => {
      try {
        console.log(`Indexing project: ${resolve(projectPath)}`);
        const index = await vectorizeProject({
          projectPath: resolve(projectPath),
          forceReindex: options.force,
          scanAll: options.scanAll,
        });
        console.log(`\nIndexed successfully!`);
        console.log(`  Chunks: ${index.chunks.length}`);
        console.log(`  Files: ${Object.keys(index.fileHashes).length}`);
        console.log(`  Embedding: ${index.embeddingType}`);
      } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

program
  .command("watch")
  .description("Watch project for documentation changes")
  .argument("<projectPath>", "Path to the project root")
  .action(async (projectPath: string) => {
    try {
      console.log(`Watching project: ${resolve(projectPath)}`);
      await startWatching(resolve(projectPath));
      console.log("Press Ctrl+C to stop watching...");
      await new Promise(() => {});
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("search")
  .description("Search indexed documentation")
  .argument("<query>", "Search query")
  .option("-p, --project <path>", "Specific project path to search")
  .option("-k, --top <number>", "Number of results", "5")
  .option("-w, --weight <number>", "Hybrid weight (0-1)", "0.7")
  .option("-f, --filter <pattern>", "Filter by file path")
  .option("-c, --category <category>", "Filter by category (e.g., learnings, troubleshooting, architecture)")
  .option("-t, --topic <topic>", "Filter by topic")
  .action(
    async (
      query: string,
      options: {
        project?: string;
        top: string;
        weight: string;
        filter?: string;
        category?: string;
        topic?: string;
      },
    ) => {
      try {
        const projectIds = options.project
          ? [getProjectId(resolve(options.project))]
          : listProjects();

        if (projectIds.length === 0) {
          console.log("No projects indexed. Use 'vectorize' first.");
          return;
        }

        let allResults: Awaited<ReturnType<typeof searchDocuments>> = [];

        for (const projectId of projectIds) {
          const index = loadIndex(projectId);
          if (index) {
            const results = await searchDocuments(index, query, {
              topK: parseInt(options.top),
              hybridWeight: parseFloat(options.weight),
              fileFilter: options.filter,
              category: options.category,
              topic: options.topic,
            });
            allResults.push(...results);
          }
        }

        allResults.sort((a, b) => b.score - a.score);
        allResults = allResults.slice(0, parseInt(options.top));

        console.log(formatSearchResults(allResults));
      } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
    },
  );

program
  .command("list")
  .description("List all indexed projects")
  .action(() => {
    const projectIds = listProjects();

    if (projectIds.length === 0) {
      console.log("No projects indexed yet.");
      return;
    }

    console.log("\nIndexed Projects:\n");
    for (const id of projectIds) {
      const index = loadIndex(id);
      if (index) {
        console.log(`  ${index.projectPath}`);
        console.log(`    Chunks: ${index.chunks.length}`);
        console.log(`    Files: ${Object.keys(index.fileHashes).length}`);
        console.log(`    Embedding: ${index.embeddingType || "unknown"}`);
        console.log(
          `    Updated: ${new Date(index.lastUpdated).toLocaleString()}\n`,
        );
      }
    }
  });

program.parse();
