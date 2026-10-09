import * as assert from "assert";
import type { OutputChannel } from "vscode";
import { appendOutputLine, setOutputChannel } from "../logger";

suite("Logger", () => {
  test("falls back to console when the output channel closes during shutdown", () => {
    let appendCalls = 0;
    const consoleLines: string[] = [];
    const originalConsoleLog = console.log;

    console.log = ((message?: unknown) => {
      consoleLines.push(String(message ?? ""));
    }) as typeof console.log;

    try {
      setOutputChannel({
        name: "Project Brain",
        append: () => {
          throw new Error("Channel has been closed");
        },
        appendLine: () => {
          appendCalls += 1;
          throw new Error("Channel has been closed");
        },
        replace: () => {
          throw new Error("Channel has been closed");
        },
        clear: () => {},
        show: () => {},
        hide: () => {},
        dispose: () => {},
      } as unknown as OutputChannel);

      assert.doesNotThrow(() => appendOutputLine("[12:00:00] first shutdown log"));
      assert.strictEqual(appendCalls, 1);
      assert.deepStrictEqual(consoleLines, ["[12:00:00] first shutdown log"]);

      assert.doesNotThrow(() => appendOutputLine("[12:00:01] second shutdown log"));
      assert.strictEqual(appendCalls, 1);
      assert.deepStrictEqual(consoleLines, [
        "[12:00:00] first shutdown log",
        "[12:00:01] second shutdown log",
      ]);
    } finally {
      setOutputChannel(undefined);
      console.log = originalConsoleLog;
    }
  });
});