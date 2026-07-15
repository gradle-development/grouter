// Background reactivation scheduler for grok-cli accounts disabled due to
// free-usage-exhausted. Periodically probes inactive accounts; reactivates any
// that can complete a tiny chat request, otherwise backs off.
//
// Grok free tier is a *rolling* 24h token window (not calendar day / not the
// billing on-demand bar). Probing too often with a heavy model just burns more
// of the same window and always returns 429 until enough prior usage ages out.
import "open-sse/index.js";

import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { refreshProviderCredentials } from "open-sse/services/oauthCredentialManager.js";
import { getProviderConnections, updateProviderConnection } from "@/lib/localDb.js";

const GROK_CLI_REACTIVATION_INTERVAL_MS =
  Number(process.env.GROK_CLI_REACTIVATION_INTERVAL_MS) || 6 * 60 * 60 * 1000; // 6h
// Free-usage is rolling 24h — default recheck after 6h, not every 1h.
const GROK_CLI_REACTIVATION_BACKOFF_MS =
  Number(process.env.GROK_CLI_REACTIVATION_BACKOFF_MS) || 6 * 60 * 60 * 1000; // 6h
const GROK_CLI_REACTIVATION_MAX_BACKOFF_MS =
  Number(process.env.GROK_CLI_REACTIVATION_MAX_BACKOFF_MS) || 24 * 60 * 60 * 1000; // 24h
// Must match the free-tier model actually used by traffic (registry only lists grok-4.5*).
const PROBE_MODEL = process.env.GROK_CLI_PROBE_MODEL || "grok-4.5";
const PROBE_INPUT = [{ type: "message", role: "user", content: "hi" }];

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

/** Parse Grok free-usage 429 body for a smarter next-retry delay. */
export function backoffMsFromGrokExhaustedBody(bodyText, now = Date.now()) {
  const text = typeof bodyText === "string" ? bodyText : "";
  // "Usage resets over a rolling 24-hour window — tokens (actual/limit): 2021622/2000000"
  const rolling = text.match(/rolling\s+(\d+)\s*-?\s*hour/i);
  const tokens = text.match(/tokens\s*\(actual\/limit\)\s*:\s*(\d+)\s*\/\s*(\d+)/i);
  if (tokens) {
    const actual = Number(tokens[1]);
    const limit = Number(tokens[2]);
    if (Number.isFinite(actual) && Number.isFinite(limit) && limit > 0 && actual > limit) {
      // Over by `over` tokens on a rolling window of `hours` — wait a fraction of the window
      // proportional to overage (min default backoff, max full window).
      const hours = rolling ? Number(rolling[1]) : 24;
      const windowMs = Math.min(
        Math.max(1, hours) * 60 * 60 * 1000,
        GROK_CLI_REACTIVATION_MAX_BACKOFF_MS,
      );
      const overRatio = Math.min(1, (actual - limit) / limit);
      // Even a tiny overage needs meaningful wait; full 2x overage → full window.
      const wait = Math.max(
        GROK_CLI_REACTIVATION_BACKOFF_MS,
        Math.round(windowMs * Math.max(0.25, overRatio)),
      );
      return Math.min(wait, GROK_CLI_REACTIVATION_MAX_BACKOFF_MS);
    }
  }
  if (rolling) {
    const hours = Number(rolling[1]);
    if (Number.isFinite(hours) && hours > 0) {
      // Recheck at half the rolling window (sooner than full 24h, later than spammy 1h).
      return Math.min(
        Math.max(GROK_CLI_REACTIVATION_BACKOFF_MS, Math.round((hours * 60 * 60 * 1000) / 2)),
        GROK_CLI_REACTIVATION_MAX_BACKOFF_MS,
      );
    }
  }
  void now;
  return GROK_CLI_REACTIVATION_BACKOFF_MS;
}

function isCooldownActive(conn, now = Date.now()) {
  if (!conn?.rateLimitedUntil) return false;
  const until = new Date(conn.rateLimitedUntil).getTime();
  return Number.isFinite(until) && until > now;
}

async function readResponseText(response) {
  try {
    if (typeof response?.text === "function") return await response.text();
  } catch { /* fall through */ }
  try {
    if (typeof response?.clone === "function") {
      const cloned = response.clone();
      if (typeof cloned?.text === "function") return await cloned.text();
    }
  } catch { /* fall through */ }
  return "";
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
    email: connection.email,
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
      // Low effort so probe doesn't burn the same free-token window we're waiting on.
      reasoning: { effort: "low", summary: "concise" },
    },
  });

  const bodyText = await readResponseText(response);
  // Cancel leftover stream body if text() didn't consume it
  try { await response.body?.cancel?.(); } catch { /* noop */ }

  return { response, bodyText };
}

export async function runGrokCliReactivationTick(deps = createDefaultDeps(), force = false) {
  if (!force && g.running) return;
  g.running = true;
  try {
    const conns = await deps.getProviderConnections({ provider: "grok-cli", isActive: false });
    // Only probe accounts that were disabled by free-usage-exhausted
    const now = Date.now();
    const exhausted = conns.filter((c) =>
      c.testStatus === "unavailable" &&
      c.lastError && /free[-_]?usage[-_]?exhausted|subscription:free-usage-exhausted/i.test(c.lastError)
    );
    // Honor per-account backoff unless force=true (manual debug trigger).
    const targets = force
      ? exhausted
      : exhausted.filter((c) => !isCooldownActive(c, now));
    const skipped = exhausted.length - targets.length;

    if (targets.length === 0) {
      console.log(
        `[GrokReactivation] no exhausted grok-cli accounts ready` +
          (skipped ? ` (${skipped} still in backoff)` : ""),
      );
      return;
    }
    console.log(
      `[GrokReactivation] checking ${targets.length} exhausted grok-cli account(s)` +
        (skipped ? ` (skipped ${skipped} in backoff)` : ""),
    );

    for (const conn of targets) {
      try {
        const { response: res, bodyText } = await probeGrokCli(conn, deps);
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
          console.log(`[GrokReactivation] ${conn.id} reactivated (status ${res.status})`);
          continue;
        }

        const stillExhausted = res.status === 429 || res.status === 402;
        if (stillExhausted) {
          const waitMs = backoffMsFromGrokExhaustedBody(bodyText || conn.lastError || "");
          const nextRetry = new Date(Date.now() + waitMs).toISOString();
          const errSnippet = (bodyText || "").slice(0, 240) || conn.lastError || `HTTP ${res.status}`;
          await deps.updateProviderConnection(conn.id, {
            rateLimitedUntil: nextRetry,
            lastErrorAt: new Date().toISOString(),
            // Keep free-usage marker so the next tick still selects this account.
            lastError: errSnippet.includes("free-usage-exhausted") || errSnippet.includes("free usage")
              ? errSnippet
              : conn.lastError,
            errorCode: res.status,
          });
          console.log(
            `[GrokReactivation] ${conn.id} still exhausted (${res.status}), next retry ${nextRetry}` +
              (bodyText ? ` | ${bodyText.slice(0, 160).replace(/\s+/g, " ")}` : ""),
          );
        } else {
          // Other hard failure (auth revoked, etc.) keep disabled but clear exhaustion marker
          await deps.updateProviderConnection(conn.id, {
            testStatus: "error",
            rateLimitedUntil: null,
            lastError: `Reactivation probe failed (${res.status})${bodyText ? `: ${bodyText.slice(0, 160)}` : ""}`,
            lastErrorAt: new Date().toISOString(),
            errorCode: res.status,
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
