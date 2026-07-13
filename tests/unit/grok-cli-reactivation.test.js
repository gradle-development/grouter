import { describe, it, expect, vi, beforeEach } from "vitest";

describe("grokCliReactivation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

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

    vi.doMock("@/lib/network/connectionProxy.js", () => ({
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
    }));

    vi.doMock("open-sse/executors/index.js", () => ({
      getExecutor: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({ response: { ok: true, status: 200, body: { cancel: vi.fn() } } }),
      }),
    }));

    vi.doMock("open-sse/services/oauthCredentialManager.js", () => ({
      refreshProviderCredentials: vi.fn().mockResolvedValue(null),
    }));

    const { runGrokCliReactivationTick } = await import("../../src/shared/services/grokCliReactivation.js");

    const deps = {
      getProviderConnections,
      updateProviderConnection,
      getExecutor: (await import("open-sse/executors/index.js")).getExecutor,
      resolveConnectionProxyConfig: (await import("@/lib/network/connectionProxy.js")).resolveConnectionProxyConfig,
      refreshProviderCredentials: (await import("open-sse/services/oauthCredentialManager.js")).refreshProviderCredentials,
    };

    await runGrokCliReactivationTick(deps);

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

    vi.doMock("@/lib/network/connectionProxy.js", () => ({
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
    }));

    vi.doMock("open-sse/executors/index.js", () => ({
      getExecutor: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({ response: { ok: false, status: 429, body: { cancel: vi.fn() } } }),
      }),
    }));

    vi.doMock("open-sse/services/oauthCredentialManager.js", () => ({
      refreshProviderCredentials: vi.fn().mockResolvedValue(null),
    }));

    const { runGrokCliReactivationTick } = await import("../../src/shared/services/grokCliReactivation.js");

    const deps = {
      getProviderConnections,
      updateProviderConnection,
      getExecutor: (await import("open-sse/executors/index.js")).getExecutor,
      resolveConnectionProxyConfig: (await import("@/lib/network/connectionProxy.js")).resolveConnectionProxyConfig,
      refreshProviderCredentials: (await import("open-sse/services/oauthCredentialManager.js")).refreshProviderCredentials,
    };

    await runGrokCliReactivationTick(deps);

    const update = updateProviderConnection.mock.calls[0][1];
    expect(update.isActive).toBeUndefined();
    expect(update.rateLimitedUntil).toBeDefined();
  });
});
