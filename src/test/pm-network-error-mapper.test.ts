import * as assert from "assert";
import { mapPmNetworkError } from "../pm-network-error-mapper";

suite("PmNetworkErrorMapper", () => {
  const provider = "openrouter";
  const model = "google/gemini-2.5-flash";

  test("maps ECONNREFUSED to NETWORK_REFUSED with UX-friendly message", () => {
    const err = new Error("fetch failed") as Error & { cause?: unknown };
    err.cause = new Error("connect ECONNREFUSED 127.0.0.1:1080");

    const mapped = mapPmNetworkError(err, provider, model);
    assert.strictEqual(mapped.errorCode, "NETWORK_REFUSED");
    assert.ok(mapped.userMessage.includes("No hay conexion"));
    assert.ok(!mapped.userMessage.toLowerCase().includes("fetch failed"));
    assert.ok(mapped.hint.length > 0);
  });

  test("maps timeout to NETWORK_TIMEOUT", () => {
    const err = new Error("ETIMEDOUT while fetching provider");
    const mapped = mapPmNetworkError(err, provider, model);
    assert.strictEqual(mapped.errorCode, "NETWORK_TIMEOUT");
  });

  test("maps DNS resolution failures to NETWORK_DNS", () => {
    const err = new Error("getaddrinfo ENOTFOUND api.openrouter.ai");
    const mapped = mapPmNetworkError(err, provider, model);
    assert.strictEqual(mapped.errorCode, "NETWORK_DNS");
  });

  test("maps upstream 4xx status", () => {
    const err = { message: "Unauthorized", status: 401 };
    const mapped = mapPmNetworkError(err, provider, model);
    assert.strictEqual(mapped.errorCode, "UPSTREAM_4XX");
  });

  test("maps upstream 5xx status", () => {
    const err = { message: "Bad gateway", response: { status: 503 } };
    const mapped = mapPmNetworkError(err, provider, model);
    assert.strictEqual(mapped.errorCode, "UPSTREAM_5XX");
  });

  test("falls back to UNKNOWN_PM_ERROR", () => {
    const err = { message: "weird custom failure" };
    const mapped = mapPmNetworkError(err, provider, model);
    assert.strictEqual(mapped.errorCode, "UNKNOWN_PM_ERROR");
  });
});
