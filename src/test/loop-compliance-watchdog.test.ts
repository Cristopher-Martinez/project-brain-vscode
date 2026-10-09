import * as assert from "assert";
import {
  COMPLIANCE_BUSY_GRACE_MS,
  COMPLIANCE_MAILBOX_REMINDER_INTERVAL_MS,
  COMPLIANCE_RECENT_ACTIVITY_WINDOW_MS,
  COMPLIANCE_WATCHDOG_SENDER_ID,
  buildComplianceMailboxReminder,
  buildComplianceWatchdogPlan,
  COMPLIANCE_WATCHDOG_IGNORE_LABEL,
  shouldSuppressComplianceWarn,
} from "../loop-compliance-watchdog";

suite("LoopComplianceWatchdog", () => {
  test("highest escalation keeps the loop alive", () => {
    const plan = buildComplianceWatchdogPlan(
      3,
      "123e4567-e89b-12d3-a456-426614174000",
    );

    assert.strictEqual(plan.level, 3);
    assert.strictEqual(plan.primaryLabel, "Reabrir chat del loop");
    assert.strictEqual(plan.secondaryLabel, "Marcar como desconectado");
    assert.strictEqual(plan.ignoreLabel, COMPLIANCE_WATCHDOG_IGNORE_LABEL);
    assert.strictEqual(plan.preservesLoop, true);
    assert.match(plan.warningMessage, /NO se cierra/);
  });

  test("clamps unsupported escalation levels", () => {
    const low = buildComplianceWatchdogPlan(
      0,
      "123e4567-e89b-12d3-a456-426614174000",
    );
    const high = buildComplianceWatchdogPlan(
      99,
      "123e4567-e89b-12d3-a456-426614174000",
    );

    assert.strictEqual(low.level, 1);
    assert.strictEqual(high.level, 3);
  });

  test("suppresses warn while the busy grace window is still open", () => {
    const startedAt = 1_000;

    assert.strictEqual(
      shouldSuppressComplianceWarn({
        startedAt,
        now: startedAt + COMPLIANCE_BUSY_GRACE_MS - 1,
      }),
      true,
    );
  });

  test("suppresses warn when there was recent tool activity", () => {
    const now = COMPLIANCE_BUSY_GRACE_MS + 10_000;

    assert.strictEqual(
      shouldSuppressComplianceWarn({
        startedAt: 0,
        now,
        lastActivityAt: now - (COMPLIANCE_RECENT_ACTIVITY_WINDOW_MS - 1),
      }),
      true,
    );

    assert.strictEqual(
      shouldSuppressComplianceWarn({
        startedAt: 0,
        now,
        lastActivityAt: now - (COMPLIANCE_RECENT_ACTIVITY_WINDOW_MS + 1),
      }),
      false,
    );
  });

  test("builds recurring mailbox reminder with session id", () => {
    const sessionId = "123e4567-e89b-12d3-a456-426614174000";
    const reminder = buildComplianceMailboxReminder(sessionId);

    assert.match(reminder, /sessionId=123e4567-e89b-12d3-a456-426614174000/);
    assert.match(reminder, /loopAwaitInput/);
    assert.strictEqual(
      COMPLIANCE_MAILBOX_REMINDER_INTERVAL_MS,
      5 * 60 * 1000,
    );
    assert.strictEqual(COMPLIANCE_WATCHDOG_SENDER_ID, "__loop_watchdog__");
  });
});