import { describe, it, expect } from "vitest";

// 9Router clamps max_tokens to a safe ceiling (8192) for Kimi NVIDIA — empirically a
// large value (≥~32k) makes the model degenerate/loop. Smaller values pass through; it
// never INJECTS a value when the client omits it. The clamp lives in
// DefaultExecutor.transformRequest (per .docs/audit/03-code-state.md), which is the
// body BaseExecutor.execute stringifies and sends upstream.
describe("Kimi NVIDIA max_tokens clamp", () => {
  async function transformedMaxTokens(model, bodyExtra) {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const executor = new DefaultExecutor("nvidia");
    const out = executor.transformRequest(model, { messages: [{ role: "user", content: "hello" }], ...bodyExtra });
    return out.max_tokens;
  }

  it("clamps a large max_tokens (64000) to the 8192 ceiling", async () => {
    expect(await transformedMaxTokens("moonshotai/kimi-k2.6", { max_tokens: 64000 })).toBe(8192);
  });

  it("honors a small max_tokens (2048) unchanged", async () => {
    expect(await transformedMaxTokens("moonshotai/kimi-k2.6", { max_tokens: 2048 })).toBe(2048);
  });

  it("does NOT inject max_tokens when client omits it", async () => {
    expect(await transformedMaxTokens("moonshotai/kimi-k2.6", {})).toBeUndefined();
  });

  it("does NOT clamp non-Kimi NVIDIA models", async () => {
    expect(await transformedMaxTokens("meta/llama-3.1-8b-instruct", { max_tokens: 64000 })).toBe(64000);
  });

  it("clamps K2.7 too (regex covers both .6 and .7)", async () => {
    expect(await transformedMaxTokens("moonshotai/kimi-k2.7", { max_tokens: 50000 })).toBe(8192);
  });
});
