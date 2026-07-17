import { describe, it, expect, vi, beforeEach } from "vitest";

describe("grokCliReactivation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadTick(mocks) {
    vi.doMock("@/lib/network/connectionProxy.js", () => ({
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock("open-sse/executors/index.js", () => ({
      getExecutor: vi.fn().mockReturnValue({
        execute: mocks.execute,
      }),
    }));
    vi.doMock("open-sse/services/oauthCredentialManager.js", () => ({
      refreshProviderCredentials: vi.fn().mockResolvedValue(null),
    }));
    const mod = await import("../../src/shared/services/grokCliReactivation.js");
    const deps = {
      getProviderConnections: mocks.getProviderConnections,
      updateProviderConnection: mocks.updateProviderConnection,
      getExecutor: (await import("open-sse/executors/index.js")).getExecutor,
      resolveConnectionProxyConfig: (await import("@/lib/network/connectionProxy.js")).resolveConnectionProxyConfig,
      refreshProviderCredentials: (await import("open-sse/services/oauthCredentialManager.js")).refreshProviderCredentials,
    };
    return { mod, deps };
  }

  it("reactivates a grok-cli account when probe returns ok", async () => {
    const updateProviderConnection = vi.fn();
    const getProviderConnections = vi.fn().mockResolvedValue([
      {
        id: "conn-grok-1",
        provider: "grok-cli",
        isActive: false,
        testStatus: "unavailable",
        lastError: "subscription:free-usage-exhausted",
        accessToken: "tok",
        refreshToken: null,
        providerSpecificData: {},
      },
    ]);

    const { mod, deps } = await loadTick({
      getProviderConnections,
      updateProviderConnection,
      execute: vi.fn().mockResolvedValue({
        response: {
          ok: true,
          status: 200,
          text: async () => "",
          body: { cancel: vi.fn() },
        },
      }),
    });

    await mod.runGrokCliReactivationTick(deps);

    expect(updateProviderConnection).toHaveBeenCalledWith("conn-grok-1", expect.objectContaining({
      isActive: true,
      testStatus: "active",
      lastError: null,
      rateLimitedUntil: null,
    }));
  });

  it("keeps account disabled when probe still returns 429 exhausted", async () => {
    const updateProviderConnection = vi.fn();
    const getProviderConnections = vi.fn().mockResolvedValue([
      {
        id: "conn-grok-2",
        provider: "grok-cli",
        isActive: false,
        testStatus: "unavailable",
        lastError: "subscription:free-usage-exhausted",
        accessToken: "tok",
        refreshToken: null,
        providerSpecificData: {},
      },
    ]);

    const body =
      '{"code":"subscription:free-usage-exhausted","error":"You\'ve used all the included free usage for model grok-4.5-build-free for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 2021622/2000000."}';

    const { mod, deps } = await loadTick({
      getProviderConnections,
      updateProviderConnection,
      execute: vi.fn().mockResolvedValue({
        response: {
          ok: false,
          status: 429,
          text: async () => body,
          body: { cancel: vi.fn() },
        },
      }),
    });

    await mod.runGrokCliReactivationTick(deps);

    const update = updateProviderConnection.mock.calls[0][1];
    expect(update.isActive).toBeUndefined();
    expect(update.rateLimitedUntil).toBeDefined();
    // Rolling free-usage → multi-hour backoff, not 1h
    const until = new Date(update.rateLimitedUntil).getTime();
    expect(until - Date.now()).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it("skips accounts still inside rateLimitedUntil backoff", async () => {
    const updateProviderConnection = vi.fn();
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const getProviderConnections = vi.fn().mockResolvedValue([
      {
        id: "conn-grok-3",
        provider: "grok-cli",
        isActive: false,
        testStatus: "unavailable",
        lastError: "subscription:free-usage-exhausted",
        rateLimitedUntil: future,
        accessToken: "tok",
        refreshToken: null,
        providerSpecificData: {},
      },
    ]);
    const execute = vi.fn();

    const { mod, deps } = await loadTick({
      getProviderConnections,
      updateProviderConnection,
      execute,
    });

    await mod.runGrokCliReactivationTick(deps);

    expect(execute).not.toHaveBeenCalled();
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("force=true probes even when rateLimitedUntil is in the future", async () => {
    const updateProviderConnection = vi.fn();
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const getProviderConnections = vi.fn().mockResolvedValue([
      {
        id: "conn-grok-4",
        provider: "grok-cli",
        isActive: false,
        testStatus: "unavailable",
        lastError: "subscription:free-usage-exhausted",
        rateLimitedUntil: future,
        accessToken: "tok",
        refreshToken: null,
        providerSpecificData: {},
      },
    ]);

    const { mod, deps } = await loadTick({
      getProviderConnections,
      updateProviderConnection,
      execute: vi.fn().mockResolvedValue({
        response: {
          ok: true,
          status: 200,
          text: async () => "",
          body: { cancel: vi.fn() },
        },
      }),
    });

    await mod.runGrokCliReactivationTick(deps, true);

    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-grok-4",
      expect.objectContaining({ isActive: true }),
    );
  });

  it("backoffMsFromGrokExhaustedBody uses rolling window + overage", async () => {
    const { backoffMsFromGrokExhaustedBody } = await import(
      "../../src/shared/services/grokCliReactivation.js"
    );
    const body =
      "Usage resets over a rolling 24-hour window — tokens (actual/limit): 2021622/2000000";
    const ms = backoffMsFromGrokExhaustedBody(body);
    // ~1% over → at least default 6h backoff, less than full 24h
    expect(ms).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
