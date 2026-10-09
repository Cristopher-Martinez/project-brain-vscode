import * as assert from "assert";
import { SwarmMailbox } from "../swarm-mailbox";
import { DAGScheduler, validateDAG } from "../task-dag";

// ─── Swarm Features Smoke Test ─────────────────────────────────────────
// Tests: Mailbox, Task DAG, Plan Approval (pure logic, no VS Code API)
// Run: npx tsx src/test/swarm-features.test.ts
// ────────────────────────────────────────────────────────────────────────

const logs: string[] = [];
const testLog = (msg: string) => logs.push(msg);

// ═══════════════════════════════════════════════════════════════════════
// MAILBOX TESTS
// ═══════════════════════════════════════════════════════════════════════

suite("SwarmMailbox", () => {
  let mailbox: SwarmMailbox;

  setup(() => {
    logs.length = 0;
    mailbox = new SwarmMailbox({ maxPostsPerWorker: 3, log: testLog });
  });

  test("should post and retrieve messages", () => {
    const id = mailbox.post({
      from: "worker-1",
      to: null,
      type: "finding",
      content: "Found a bug in auth module",
    });
    assert.ok(id, "Should return a message ID");

    const all = mailbox.getAll();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].from, "worker-1");
    assert.strictEqual(all[0].type, "finding");
    assert.strictEqual(all[0].content, "Found a bug in auth module");
  });

  test("should filter messages for specific worker", () => {
    // Worker 1 broadcasts
    mailbox.post({
      from: "worker-1",
      to: null,
      type: "finding",
      content: "Broadcast from 1",
    });
    // Worker 2 sends direct to worker 3
    mailbox.post({
      from: "worker-2",
      to: "worker-3",
      type: "question",
      content: "Direct to 3",
    });
    // Worker 1 sends direct to worker 2
    mailbox.post({
      from: "worker-1",
      to: "worker-2",
      type: "update",
      content: "Direct to 2",
    });

    // Worker-2 should see: broadcast from 1 + direct to 2 (NOT direct to 3)
    const forWorker2 = mailbox.getFor("worker-2");
    assert.strictEqual(
      forWorker2.length,
      2,
      "Worker-2 sees broadcast + direct",
    );
    assert.ok(
      forWorker2.some(
        (m: { content: string }) => m.content === "Broadcast from 1",
      ),
    );
    assert.ok(
      forWorker2.some((m: { content: string }) => m.content === "Direct to 2"),
    );

    // Worker-3 should see: broadcast from 1 + direct to 3
    const forWorker3 = mailbox.getFor("worker-3");
    assert.strictEqual(
      forWorker3.length,
      2,
      "Worker-3 sees broadcast + direct",
    );
    assert.ok(
      forWorker3.some((m: { content: string }) => m.content === "Direct to 3"),
    );
  });

  test("should exclude own messages", () => {
    mailbox.post({
      from: "worker-1",
      to: null,
      type: "update",
      content: "My own broadcast",
    });
    const forSelf = mailbox.getFor("worker-1");
    assert.strictEqual(forSelf.length, 0, "Worker should not see own messages");
  });

  test("should enforce rate limiting", () => {
    // Max 3 per worker
    assert.ok(
      mailbox.post({ from: "worker-1", type: "update", content: "msg 1" }),
    );
    assert.ok(
      mailbox.post({ from: "worker-1", type: "update", content: "msg 2" }),
    );
    assert.ok(
      mailbox.post({ from: "worker-1", type: "update", content: "msg 3" }),
    );
    const dropped = mailbox.post({
      from: "worker-1",
      type: "update",
      content: "msg 4",
    });
    assert.strictEqual(dropped, null, "4th message should be rate-limited");
    assert.strictEqual(mailbox.getAll().length, 3, "Only 3 messages stored");

    // Different worker is not affected
    assert.ok(
      mailbox.post({
        from: "worker-2",
        type: "finding",
        content: "I can post",
      }),
    );
  });

  test("should reset rate limits", () => {
    mailbox.post({ from: "worker-1", type: "update", content: "msg 1" });
    mailbox.post({ from: "worker-1", type: "update", content: "msg 2" });
    mailbox.post({ from: "worker-1", type: "update", content: "msg 3" });
    assert.strictEqual(
      mailbox.post({ from: "worker-1", type: "update", content: "blocked" }),
      null,
    );

    mailbox.resetAllRateLimits();
    assert.ok(
      mailbox.post({
        from: "worker-1",
        type: "update",
        content: "after reset",
      }),
    );
  });

  test("should format context for worker injection", () => {
    mailbox.post({
      from: "worker-2",
      to: null,
      type: "finding",
      content: "Auth bug found",
    });
    const ctx = mailbox.formatContextForWorker("worker-1");
    assert.ok(ctx.includes("📬 Mailbox Messages"), "Should have header");
    assert.ok(ctx.includes("FINDING"), "Should include type");
    assert.ok(ctx.includes("worker-2"), "Should include sender");
    assert.ok(ctx.includes("Auth bug found"), "Should include content");
    assert.ok(ctx.includes("swarm_mailbox_post"), "Should mention the tool");
  });

  test("should return empty context when no new messages", () => {
    const ctx = mailbox.formatContextForWorker("worker-1");
    assert.strictEqual(ctx, "", "No messages = empty context");
  });

  test("should compute stats correctly", () => {
    mailbox.post({ from: "worker-1", type: "finding", content: "f1" });
    mailbox.post({ from: "worker-1", type: "question", content: "q1" });
    mailbox.post({ from: "worker-2", type: "finding", content: "f2" });

    const stats = mailbox.getStats();
    assert.strictEqual(stats.totalMessages, 3);
    assert.strictEqual(stats.byType.finding, 2);
    assert.strictEqual(stats.byType.question, 1);
    assert.strictEqual(stats.byWorker["worker-1"], 2);
    assert.strictEqual(stats.byWorker["worker-2"], 1);
  });

  test("should track unread count", () => {
    mailbox.post({
      from: "worker-1",
      to: null,
      type: "update",
      content: "broadcast",
    });
    assert.strictEqual(mailbox.getUnreadCount("worker-2"), 1);
    mailbox.getFor("worker-2", { markAsRead: true });
    assert.strictEqual(mailbox.getUnreadCount("worker-2"), 0);
  });

  test("should broadcast convenience method", () => {
    const id = mailbox.broadcast("worker-1", "Hello everyone", "consensus");
    assert.ok(id);
    const all = mailbox.getAll();
    assert.strictEqual(all[0].to, null, "Broadcast has null recipient");
    assert.strictEqual(all[0].type, "consensus");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TASK DAG TESTS
// ═══════════════════════════════════════════════════════════════════════

suite("Task DAG", () => {
  suite("validateDAG", () => {
    test("should validate a simple linear chain", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B", dependsOn: ["A"] },
        { id: "C", prompt: "do C", dependsOn: ["B"] },
      ];
      const result = validateDAG(tasks);
      assert.ok(result.valid, "Linear chain should be valid");
      assert.deepStrictEqual(result.roots, ["A"]);
      assert.strictEqual(result.cycles.length, 0);
    });

    test("should detect cycles", () => {
      const tasks = [
        { id: "A", prompt: "do A", dependsOn: ["C"] },
        { id: "B", prompt: "do B", dependsOn: ["A"] },
        { id: "C", prompt: "do C", dependsOn: ["B"] },
      ];
      const result = validateDAG(tasks);
      assert.ok(!result.valid, "Cyclic graph should be invalid");
      assert.ok(result.cycles.length > 0, "Should report cycles");
    });

    test("should detect missing dependencies", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B", dependsOn: ["X"] },
      ];
      const result = validateDAG(tasks);
      assert.ok(!result.valid, "Missing dep should be invalid");
      assert.ok(result.missingDeps.length > 0);
    });

    test("should handle diamond dependencies", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B", dependsOn: ["A"] },
        { id: "C", prompt: "do C", dependsOn: ["A"] },
        { id: "D", prompt: "do D", dependsOn: ["B", "C"] },
      ];
      const result = validateDAG(tasks);
      assert.ok(result.valid, "Diamond should be valid");
      assert.deepStrictEqual(result.roots, ["A"]);
    });

    test("should accept tasks with no dependencies", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B" },
        { id: "C", prompt: "do C" },
      ];
      const result = validateDAG(tasks);
      assert.ok(result.valid);
      assert.strictEqual(result.roots.length, 3, "All are roots");
    });
  });

  suite("DAGScheduler", () => {
    test("should return ready tasks (no deps)", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B", dependsOn: ["A"] },
      ];
      const scheduler = new DAGScheduler(tasks);
      const ready = scheduler.getReady(10);
      assert.strictEqual(ready.length, 1);
      assert.strictEqual(ready[0].id, "A");
    });

    test("should unblock dependents on completion", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B", dependsOn: ["A"] },
        { id: "C", prompt: "do C", dependsOn: ["A"] },
      ];
      const scheduler = new DAGScheduler(tasks);

      // Initially only A is ready
      let ready = scheduler.getReady(10);
      assert.strictEqual(ready.length, 1);
      assert.strictEqual(ready[0].id, "A");

      // Complete A → B and C should become ready
      scheduler.markCompleted("A");
      ready = scheduler.getReady(10);
      assert.strictEqual(ready.length, 2);
      const readyIds = ready.map((t: { id: string }) => t.id).sort();
      assert.deepStrictEqual(readyIds, ["B", "C"]);
    });

    test("should cascade failure to dependents", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B", dependsOn: ["A"] },
        { id: "C", prompt: "do C", dependsOn: ["B"] },
      ];
      const scheduler = new DAGScheduler(tasks);

      scheduler.getReady(10); // marks A as running
      scheduler.markFailed("A");

      // B and C should both be blocked
      const ready = scheduler.getReady(10);
      assert.strictEqual(
        ready.length,
        0,
        "No tasks should be ready after root failure",
      );
      // DAG IS complete: all tasks are in terminal state (failed/blocked)
      assert.ok(
        scheduler.isComplete(),
        "Should be complete — no more work possible",
      );

      const statuses = scheduler.getAllStatuses();
      const statusMap = new Map(
        statuses.map((s: { taskId: string; status: string }) => [
          s.taskId,
          s.status,
        ]),
      );
      assert.strictEqual(statusMap.get("A"), "failed");
      assert.strictEqual(statusMap.get("B"), "blocked");
      assert.strictEqual(statusMap.get("C"), "blocked");
    });

    test("should respect concurrency limit in getReady", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B" },
        { id: "C", prompt: "do C" },
      ];
      const scheduler = new DAGScheduler(tasks);
      const ready = scheduler.getReady(2);
      assert.strictEqual(ready.length, 2, "Should respect limit");
    });

    test("should report complete when all done", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B", dependsOn: ["A"] },
      ];
      const scheduler = new DAGScheduler(tasks);
      scheduler.getReady(10);
      scheduler.markCompleted("A");
      scheduler.getReady(10);
      scheduler.markCompleted("B");
      assert.ok(scheduler.isComplete(), "Should be complete");
    });

    test("should return status counts", () => {
      const tasks = [
        { id: "A", prompt: "do A" },
        { id: "B", prompt: "do B", dependsOn: ["A"] },
        { id: "C", prompt: "do C", dependsOn: ["A"] },
      ];
      const scheduler = new DAGScheduler(tasks);
      scheduler.getReady(10); // A → running
      scheduler.markCompleted("A");

      const counts = scheduler.getStatusCounts();
      assert.strictEqual(counts.completed, 1);
      assert.strictEqual(counts.ready, 2);
    });

    test("should handle diamond with partial completion", () => {
      const tasks = [
        { id: "A", prompt: "root" },
        { id: "B", prompt: "left", dependsOn: ["A"] },
        { id: "C", prompt: "right", dependsOn: ["A"] },
        { id: "D", prompt: "join", dependsOn: ["B", "C"] },
      ];
      const scheduler = new DAGScheduler(tasks);

      scheduler.getReady(10);
      scheduler.markCompleted("A");

      // B and C are ready
      scheduler.getReady(10);
      scheduler.markCompleted("B");

      // D should NOT be ready yet (C still pending)
      let ready = scheduler.getReady(10);
      assert.ok(
        !ready.some((t: { id: string }) => t.id === "D"),
        "D should wait for C",
      );

      scheduler.markCompleted("C");
      ready = scheduler.getReady(10);
      assert.ok(
        ready.some((t: { id: string }) => t.id === "D"),
        "D should be ready after both B and C",
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PLAN APPROVAL TESTS (types + parsePlanOutput only — no VS Code API)
// ═══════════════════════════════════════════════════════════════════════

// plan-approval.ts imports vscode, so we can only test parsePlanOutput
// and buildPlanningPrompt from compiled dist/ (they don't use vscode API)
suite("Plan Approval — Pure Functions", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let planMod: Record<string, (...args: unknown[]) => unknown>;

  suiteSetup(() => {
    try {
      // plan-approval imports vscode — will fail outside extension host
      planMod = require("../plan-approval");
    } catch {
      // VS Code import will fail outside extension host — skip
      console.log("  ⚠ plan-approval requires VS Code — skipping live import");
    }
  });

  test("should export parsePlanOutput function", function () {
    if (!planMod) return this.skip();
    assert.strictEqual(typeof planMod.parsePlanOutput, "function");
  });

  test("should parse a valid plan output", function () {
    if (!planMod) return this.skip();

    const rawText = `
Here's my analysis:

\`\`\`plan
## Plan: Fix auth module

### What I'll do
1. Review auth.ts
2. Fix the token validation bug

### Files to read
- src/auth.ts
- src/middleware.ts

### Files to modify
- src/auth.ts

### Tools I'll use
- read_file
- replace_string_in_file

### Estimated rounds
3

### Risk assessment
medium - touches auth logic
\`\`\`
`;

    const plan = planMod.parsePlanOutput("task-1", rawText) as {
      taskId: string;
      planText: string;
      riskLevel: string;
      intendedReads: string[];
      intendedWrites: string[];
      intendedTools: string[];
      estimatedRounds: number;
    };
    assert.strictEqual(plan.taskId, "task-1");
    assert.ok(plan.planText.length > 0);
    assert.strictEqual(plan.riskLevel, "medium");
    assert.ok(plan.intendedReads.length > 0, "Should extract reads");
    assert.ok(plan.intendedWrites.length > 0, "Should extract writes");
    assert.ok(plan.intendedTools.length > 0, "Should extract tools");
  });

  test("should export buildPlanningPrompt function", function () {
    if (!planMod) return this.skip();
    const prompt = planMod.buildPlanningPrompt("worker-1") as string;
    assert.ok(prompt.includes("PLANNING MODE"), "Should mention planning mode");
    assert.ok(prompt.includes("worker-1"), "Should include worker ID");
    assert.ok(prompt.includes("```plan"), "Should include plan format");
  });
});
