// Background reactivation scheduler for grok-cli accounts disabled due to
// free-usage-exhausted. Periodically probes inactive accounts; reactivates any
// that can complete a tiny chat request, otherwise backs off.
import "open-sse/index.js";

import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { refreshProviderCredentials } from "open-sse/services/oauthCredentialManager.js";
import { getProviderConnections, updateProviderConnection } from "@/lib/localDb.js";

const GROK_CLI_REACTIVATION_INTERVAL_MS = Number(process.env.GROK_CLI_REACTIVATION_INTERVAL_MS) || 60 * 60 * 1000; // 1h
const GROK_CLI_REACTIVATION_BACKOFF_MS = Number(process.env.GROK_CLI_REACTIVATION_BACKOFF_MS) || 60 * 60 * 1000; // 1h
const PROBE_MODEL = "grok-3";
const PROBE_INPUT = [{ type: "message", role: "user", content: "ping" }];

// Process-level singleton so Next.js dev reload doesn't spawn many schedulers.
const g = (global.__grokCliReactivation ??= {
  interval: null,
  running: false,
});

function createDefaultDeps() {
  return {
    getProviderConnections,
    updateProviderConnection,
    getExecutor,
    resolveConnectionProxyConfig,
    refreshProviderCredentials,
  };
}

async function probeGrokCli(connection, deps) {
  const proxyCfg = await deps.resolveConnectionProxyConfig(connection.providerSpecificData || {});
  const proxyOptions = {
    connectionProxyEnabled: proxyCfg.connectionProxyEnabled === true,
    connectionProxyUrl: proxyCfg.connectionProxyUrl || "",
    connectionNoProxy: proxyCfg.connectionNoProxy || "",
    vercelRelayUrl: proxyCfg.vercelRelayUrl || "",
    strictProxy: false,
  };

  let credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
  };

  // Refresh token if needed before probing
  if (connection.refreshToken) {
    try {
      const refreshed = await deps.refreshProviderCredentials("grok-cli", credentials, console);
      if (refreshed?.accessToken) {
        credentials.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) credentials.refreshToken = refreshed.refreshToken;
        // Persist refreshed tokens so the next request uses them
        await deps.updateProviderConnection(connection.id, {
          accessToken: refreshed.accessToken,
          ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
          ...(refreshed.expiresIn ? { expiresIn: refreshed.expiresIn } : {}),
          ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
        });
      }
    } catch (e) {
      console.warn(`[GrokReactivation] ${connection.id}: token refresh failed: ${e.message}`);
    }
  }

  const executor = deps.getExecutor("grok-cli");
  const { response } = await executor.execute({
    model: PROBE_MODEL,
    stream: false,
    credentials,
    proxyOptions,
    log: console,
    body: {
      model: PROBE_MODEL,
      input: PROBE_INPUT,
      instructions: "",
      stream: false,
      store: false,
      max_output_tokens: 1,
    },
  });

  // Cancel body to avoid leaking streams
  try { await response.body?.cancel?.(); } catch { /* noop */ }

  return response;
}

export async function runGrokCliReactivationTick(deps = createDefaultDeps(), force = false) {
  if (!force && g.running) return;
  g.running = true;
  try {
    const conns = await deps.getProviderConnections({ provider: "grok-cli", isActive: false });
    // Only probe accounts that were disabled by free-usage-exhausted
    const targets = conns.filter((c) =>
      c.testStatus === "unavailable" &&
      c.lastError && /free[-_]?usage[-_]?exhausted|subscription:free-usage-exhausted/i.test(c.lastError)
    );

    if (targets.length === 0) {
    console.log("[GrokReactivation] no exhausted grok-cli accounts found");
    return;
  }
    console.log(`[GrokReactivation] checking ${targets.length} exhausted grok-cli account(s)`);

    for (const conn of targets) {
      try {
        const res = await probeGrokCli(conn, deps);
        if (res.ok || res.status === 400) {
          // 400 often means auth succeeded but request shape rejected; free-exhausted usually returns 429/402
          await deps.updateProviderConnection(conn.id, {
            isActive: true,
            testStatus: "active",
            lastError: null,
            lastErrorAt: null,
            rateLimitedUntil: null,
            errorCode: null,
            backoffLevel: 0,
          });
          console.log(`[GrokReactivation] ${conn.id} reactivated`);
          continue;
        }

        const stillExhausted = res.status === 429 || res.status === 402;
        if (stillExhausted) {
          const nextRetry = new Date(Date.now() + GROK_CLI_REACTIVATION_BACKOFF_MS).toISOString();
          await deps.updateProviderConnection(conn.id, {
            rateLimitedUntil: nextRetry,
            lastErrorAt: new Date().toISOString(),
          });
          console.log(`[GrokReactivation] ${conn.id} still exhausted, next retry ${nextRetry}`);
        } else {
          // Other hard failure (auth revoked, etc.) keep disabled but clear exhaustion marker
          await deps.updateProviderConnection(conn.id, {
            testStatus: "error",
            rateLimitedUntil: null,
            lastError: `Reactivation probe failed (${res.status})`,
            lastErrorAt: new Date().toISOString(),
          });
          console.log(`[GrokReactivation] ${conn.id} probe failed with ${res.status}, marked error`);
        }
      } catch (e) {
        console.warn(`[GrokReactivation] ${conn.id}: probe error: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn("[GrokReactivation] tick error:", e.message);
  } finally {
    g.running = false;
  }
}

export function startGrokCliReactivation() {
  if (g.interval) return;
  console.log("[GrokReactivation] scheduler started");
  runGrokCliReactivationTick().catch(() => {});
  g.interval = setInterval(() => {
    runGrokCliReactivationTick().catch(() => {});
  }, GROK_CLI_REACTIVATION_INTERVAL_MS);
  if (g.interval.unref) g.interval.unref();
}

export function stopGrokCliReactivation() {
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
  }
}
