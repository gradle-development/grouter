import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import {
  KiroBulkImportManager,
  KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY,
  buildLookupResponse,
} from "./kiroBulkImportManager.js";
import { createProviderConnection, getProviderConnectionById } from "../../../models/index.js";

function noopBrowser() {
  return { close: async () => {}, __ninerouterProxyUrl: null };
}

function findPythonBinary() {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return "python3";
}

const PYTHON_BIN = findPythonBinary();
const GROK_CLI_PROVIDER_ID = "grok-cli";
const MAX_REGISTER_RETRY_ATTEMPTS = 3;

function rotateProxySessionId(proxyUrl) {
  if (!proxyUrl) return proxyUrl;
  try {
    const parsed = new URL(proxyUrl);
    if (!parsed.username) return proxyUrl;
    const newSid = Math.random().toString(36).slice(2, 10);
    const newUsername = parsed.username.replace(/sid-[a-zA-Z0-9_]+/i, `sid-${newSid}`);
    if (newUsername === parsed.username) return proxyUrl;
    parsed.username = newUsername;
    return parsed.toString();
  } catch {
    return proxyUrl;
  }
}

function normalizeSso(raw) {
  let token = String(raw || "").trim();
  if (token.startsWith("sso=")) token = token.slice(4);
  return token;
}

async function saveGrokCliConnection({ email, password, sso, accessToken, refreshToken }) {
  if (!accessToken || !refreshToken) {
    throw new Error("Missing grok-cli access_token/refresh_token (CPA mint required)");
  }
  const conn = await createProviderConnection({
    provider: GROK_CLI_PROVIDER_ID,
    authType: "oauth",
    name: email || "grok-cli-import",
    email: email || undefined,
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    testStatus: "active",
    providerSpecificData: {
      automation: "grokreg-cpa",
      // SSO kept only as recovery metadata — not saved as grok-web connection.
      sso: sso ? normalizeSso(sso) : undefined,
      password: password || undefined,
      importedAt: new Date().toISOString(),
    },
  });
  return conn;
}

async function assertConnectionPersisted(connection) {
  if (!connection?.id) throw new Error("Grok connection save returned no id");
  const saved = await getProviderConnectionById(connection.id);
  if (!saved) throw new Error(`Grok connection ${connection.id} missing after save`);
  return saved;
}

function looksLikeOauthToken(value) {
  const token = String(value || "").trim();
  if (token.length < 20) return false;
  if (token.startsWith("eyJ") || token.split(".").length >= 3) return true;
  return token.length >= 40 && !/\s/.test(token);
}

/**
 * Parse bulk lines for grok-cli:
 * - email|password|sso  (or ----) → CPA mint → grok-cli OAuth
 * - access_token|refresh_token
 * - email|access_token|refresh_token
 * Placeholder accounts for N disposable registrations use registerCount (not this parser).
 */
export function parseGrokBulkAccounts(accounts = []) {
  const parsed = [];
  const invalidLines = [];
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return { parsed, invalidLines };
  list.forEach((raw, index) => {
    const line = String(raw || "").trim();
    if (!line || line.startsWith("#")) return;
    const parts = line.includes("----") ? line.split("----") : line.split("|");
    if (parts.length >= 3 && String(parts[0]).includes("@")) {
      const email = parts[0].trim();
      const mid = parts[1].trim();
      const third = parts[2].trim();
      // JWT/oauth pair → direct token import; otherwise email|password|sso
      if (looksLikeOauthToken(mid) && looksLikeOauthToken(third)) {
        parsed.push({
          line: index + 1,
          mode: "token-import",
          email,
          password: "",
          accessToken: mid,
          refreshToken: third,
        });
        return;
      }
      const sso = normalizeSso(third);
      if (email && mid && sso) {
        parsed.push({
          line: index + 1,
          mode: "sso-import",
          email,
          password: mid,
          sso,
        });
        return;
      }
    }
    if (parts.length >= 2) {
      const accessToken = parts[0].trim();
      const refreshToken = parts[1].trim();
      if (looksLikeOauthToken(accessToken) && looksLikeOauthToken(refreshToken)) {
        parsed.push({
          line: index + 1,
          mode: "token-import",
          email: `cli-${accessToken.slice(0, 8)}`,
          password: "",
          accessToken,
          refreshToken,
        });
        return;
      }
    }
    invalidLines.push(index + 1);
  });
  return { parsed, invalidLines };
}

export class GrokBulkImportManager extends KiroBulkImportManager {
  constructor({
    browserLauncher,
    socialExchange = null,
    storageName = "grok-bulk-import",
  } = {}) {
    super({
      browserLauncher: browserLauncher || (async () => noopBrowser()),
      googleAutomation: null,
      socialExchange,
      storageName,
    });
  }

  async startJob({
    accounts,
    concurrency,
    engine,
    headless,
    proxyUrl,
    proxyUrls,
    proxyMode,
    proxyPoolId,
    proxySource,
    randomizeProxySession,
    jobFields,
    registerCount,
    mailProvider,
    mailApi,
    mailDomains,
    mailApiKey,
    mailAuthMode,
    enableNsfw,
  }) {
    const count = Math.max(0, Math.min(50, Number(registerCount) || 0));
    const { parsed, invalidLines } = parseGrokBulkAccounts(accounts);

    // Mode A: auto-register N accounts → always CPA mint → grok-cli only
    if (count > 0) {
      const domains = Array.isArray(mailDomains)
        ? mailDomains
        : String(mailDomains || "")
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean);
      const placeholders = Array.from({ length: count }, (_, i) => ({
        line: i + 1,
        email: `pending-${i + 1}@placeholder`,
        password: crypto.randomUUID(),
        mode: "register",
      }));
      return super.startJob({
        accounts: placeholders.map((a) => `${a.email}|${a.password}`),
        concurrency: concurrency || 1,
        engine,
        headless,
        proxyUrl,
        proxyUrls,
        proxyMode,
        proxyPoolId,
        proxySource,
        randomizeProxySession,
        jobFields: {
          ...(jobFields || {}),
          accountsMeta: placeholders,
          mailProvider: mailProvider || "cloudflare",
          mailApi: mailApi || "",
          mailDomains: domains,
          mailApiKey: mailApiKey || "",
          mailAuthMode: mailAuthMode || "none",
          enableCpa: true, // always — product is grok-cli OAuth
          enableNsfw: Boolean(enableNsfw),
          registerCount: count,
        },
      });
    }

    // Mode B: paste email|password|sso and/or access_token|refresh_token
    if (!parsed.length || invalidLines.length) {
      const error =
        "Grok bulk: set registerCount>0 for auto-register, or paste email|password|sso / access_token|refresh_token lines.";
      throw Object.assign(new Error(error), { error, invalidLines });
    }
    return super.startJob({
      accounts: parsed.map((a, i) => {
        const email = a.email?.includes("@") ? a.email : `cli-import-${i + 1}@local`;
        return `${email}|${a.mode || "token-import"}`;
      }),
      concurrency: concurrency || KIRO_BULK_IMPORT_DEFAULT_CONCURRENCY,
      engine,
      headless,
      proxyUrl,
      proxyUrls,
      proxyMode,
      proxyPoolId,
      proxySource,
      randomizeProxySession,
      jobFields: {
        ...(jobFields || {}),
        accountsMeta: parsed,
        enableCpa: true,
        enableNsfw: Boolean(enableNsfw),
      },
    });
  }

  async processAccount(job, account, workerId) {
    const meta =
      (job.accountsMeta || []).find((item) => item.line === account.line) || {};
    const mode =
      meta.mode ||
      (meta.accessToken ? "token-import" : meta.sso ? "sso-import" : "register");

    if (mode === "token-import") {
      return this._processTokenImport(job, account, workerId, meta);
    }
    if (mode === "sso-import") {
      return this._processSsoImportPython(job, account, workerId, meta);
    }
    return this._processRegisterPythonRetry(job, account, workerId, meta);
  }

  async cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job?._pythonChildren) {
      for (const child of job._pythonChildren.values()) {
        if (child && !child.killed && child.exitCode === null) {
          child.kill("SIGTERM");
        }
      }
      job._pythonChildren.clear();
    }
    return super.cancelJob(jobId);
  }

  async _processTokenImport(job, account, workerId, meta) {
    try {
      this.setAccountStep(account, "importing_tokens", `Worker ${workerId} saving grok-cli OAuth`);
      await this.persistJobSnapshot(job, { forcePreview: false });
      const connection = await saveGrokCliConnection({
        email: meta.email || account.email,
        accessToken: meta.accessToken,
        refreshToken: meta.refreshToken,
      });
      await assertConnectionPersisted(connection);
      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: "grok-cli OAuth saved",
      });
    } catch (error) {
      this.finalizeAccount(account, "failed", {
        error: error.message,
        step: "token_import_failed",
        message: error.message,
      });
    } finally {
      account.password = undefined;
      await this.persistJobSnapshot(job, { forcePreview: true });
    }
  }

  async _processSsoImportPython(job, account, workerId, meta) {
    const SCRIPT_DIR = path.join(process.cwd(), "scripts", "python");
    const TIMEOUT_MS = 8 * 60_000;
    const email = meta.email || account.email;
    const password = meta.password || account.password || "";
    const sso = normalizeSso(meta.sso);
    let currentProxyUrl = job.proxyUrl || null;

    if (!email || !password || !sso) {
      this.finalizeAccount(account, "failed", {
        error: "sso-import needs email|password|sso",
        step: "sso_import_invalid",
        message: "sso-import needs email|password|sso",
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return;
    }

    this.setAccountStep(
      account,
      "python_mint_sso",
      `Worker ${workerId} python -m grokreg mint-sso`
    );
    account.email = email;
    await this.persistJobSnapshot(job, { forcePreview: false });

    const args = [
      "-m",
      "grokreg",
      "mint-sso",
      "--email",
      email,
      "--password",
      password,
      "--sso",
      sso,
    ];
    if (currentProxyUrl) args.push("--proxy", currentProxyUrl);

    const env = {
      ...process.env,
      PYTHONPATH: SCRIPT_DIR,
      PYTHONUNBUFFERED: "1",
    };

    try {
      let stderrFull = "";
      const stdout = await new Promise((resolve, reject) => {
        const child = execFile(
          PYTHON_BIN,
          args,
          { cwd: SCRIPT_DIR, env, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
          (err, out, stderr) => {
            if (stderr) {
              for (const line of String(stderr).split("\n")) {
                const match = line.match(/\[(\w+)\]\s+(.+)/);
                if (match) this.setAccountStep(account, match[1], match[2].trim());
              }
            }
            if (err) {
              if (out && String(out).trim().startsWith("{")) {
                resolve(out);
                return;
              }
              if (err.killed) {
                reject(new Error(`Grok mint-sso timed out after ${TIMEOUT_MS}ms`));
              } else {
                const errMsg = (out || stderrFull || stderr || err.message || "").slice(0, 2000);
                reject(
                  new Error(
                    `Grok mint-sso exit ${err.code}: ${errMsg}`
                  )
                );
              }
              return;
            }
            resolve(out);
          }
        );

        let stderrBuf = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => {
          stderrBuf += chunk;
          stderrFull += chunk;
          const lines = stderrBuf.split("\n");
          stderrBuf = lines.pop() || "";
          for (const line of lines) {
            const match = line.match(/\[(\w+)\]\s+(.+)/);
            if (match) this.setAccountStep(account, match[1], match[2].trim());
          }
        });

        const cancelKey = `python-sso-${account.line ?? account.email}`;
        job._pythonChildren = job._pythonChildren || new Map();
        job._pythonChildren.set(cancelKey, child);
      });

      const lines = String(stdout || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      let mintResult = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          mintResult = JSON.parse(lines[i]);
          break;
        } catch {
          /* continue */
        }
      }
      if (!mintResult) {
        throw new Error(`No JSON from grokreg mint-sso: ${String(stdout).slice(0, 200)}`);
      }
      if (mintResult.status !== "success" || !mintResult.access_token || !mintResult.refresh_token) {
        this.finalizeAccount(account, "failed", {
          error: mintResult.error || "CPA mint missing tokens",
          step: "sso_mint_failed",
          message: mintResult.error || "CPA mint missing tokens",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        return;
      }

      this.setAccountStep(account, "saving_connection", "Saving grok-cli OAuth");
      await this.persistJobSnapshot(job, { forcePreview: true });
      const connection = await saveGrokCliConnection({
        email: mintResult.email || email,
        password,
        sso: mintResult.sso || sso,
        accessToken: mintResult.access_token,
        refreshToken: mintResult.refresh_token,
      });
      await assertConnectionPersisted(connection);
      this.finalizeAccount(account, "success", {
        connectionId: connection.id,
        step: "connection_saved",
        message: `grok-cli saved ${mintResult.email || email}`,
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
    } catch (error) {
      this.finalizeAccount(account, "failed", {
        error: `SSO mint error: ${error.message}`,
        step: "sso_mint_exception",
        message: error.message,
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
    } finally {
      account.password = undefined;
      if (job._pythonChildren) {
        const cancelKey = `python-sso-${account.line ?? account.email}`;
        const child = job._pythonChildren.get(cancelKey);
        if (child && !child.killed && child.exitCode === null) child.kill("SIGTERM");
        job._pythonChildren.delete(cancelKey);
      }
    }
  }

  async _processRegisterPythonRetry(job, account, workerId) {
    let currentProxyUrl = job.proxyUrl || null;

    for (let attempt = 1; attempt <= MAX_REGISTER_RETRY_ATTEMPTS; attempt++) {
      if (job.cancelRequested) {
        this.finalizeAccount(account, "cancelled", { error: "Job cancelled" });
        return;
      }
      if (attempt > 1) {
        const rotated = rotateProxySessionId(currentProxyUrl);
        this.setAccountStep(
          account,
          "retrying_register",
          `Retry register (attempt ${attempt}/${MAX_REGISTER_RETRY_ATTEMPTS})`
        );
        await this.persistJobSnapshot(job, { forcePreview: false });
        currentProxyUrl = rotated;
      }
      const result = await this._processRegisterPython(
        job,
        account,
        workerId,
        currentProxyUrl,
        attempt
      );
      if (result !== "needs_retry") {
        account.password = undefined;
        return;
      }
    }

    this.finalizeAccount(account, "failed", {
      error: `Grok register failed after ${MAX_REGISTER_RETRY_ATTEMPTS} attempts`,
      step: "register_failed_exhausted",
      message: `Register failed after ${MAX_REGISTER_RETRY_ATTEMPTS} attempts`,
    });
    account.password = undefined;
    await this.persistJobSnapshot(job, { forcePreview: true });
  }

  async _processRegisterPython(job, account, workerId, currentProxyUrl, attempt) {
    const SCRIPT_DIR = path.join(process.cwd(), "scripts", "python");
    const TIMEOUT_MS = 20 * 60_000;

    this.setAccountStep(
      account,
      "python_automation",
      `Worker ${workerId} python -m grokreg register (attempt ${attempt})`
    );
    await this.persistJobSnapshot(job, { forcePreview: false });

    const args = ["-m", "grokreg", "register"];
    if (currentProxyUrl) args.push("--proxy", currentProxyUrl);

    const mailProvider = job.mailProvider || "cloudflare";
    args.push("--mail-provider", mailProvider);
    if (job.mailApi) args.push("--cloudflare-api-base", String(job.mailApi).replace(/\/$/, ""));
    if (job.mailApiKey && mailProvider !== "cf-email") args.push("--cloudflare-api-key", job.mailApiKey);
    if (job.mailAuthMode && mailProvider !== "cf-email") args.push("--cloudflare-auth-mode", job.mailAuthMode);
    const domains = job.mailDomains || [];
    if (domains[0]) args.push("--domain", domains[0]);
    args.push("--enable-cpa"); // always mint grok-cli OAuth
    if (job.headless) args.push("--headless");
    if (job.enableNsfw) args.push("--enable-nsfw");

    const env = {
      ...process.env,
      PYTHONPATH: SCRIPT_DIR,
      PYTHONUNBUFFERED: "1",
    };

    let stderrFull = "";
    const childPromise = new Promise((resolve, reject) => {
      const child = execFile(
        PYTHON_BIN,
        args,
        { cwd: SCRIPT_DIR, env, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (stderr) {
            for (const line of String(stderr).split("\n")) {
              const match = line.match(/\[(\w+)\]\s+(.+)/);
              if (match) this.setAccountStep(account, match[1], match[2].trim());
            }
          }
          if (err) {
            // Python exits 1 on failure but may still print JSON on stdout
            if (stdout && String(stdout).trim().startsWith("{")) {
              resolve(stdout);
              return;
            }
            if (err.killed) {
              reject(new Error(`Grok python timed out after ${TIMEOUT_MS}ms`));
            } else {
              const errMsg = (stdout || stderrFull || stderr || err.message || "").slice(0, 2000);
              reject(
                new Error(
                  `Grok python exit ${err.code}: ${errMsg}`
                )
              );
            }
            return;
          }
          resolve(stdout);
        }
      );

      let stderrBuf = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderrBuf += chunk;
        stderrFull += chunk;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() || "";
        for (const line of lines) {
          const match = line.match(/\[(\w+)\]\s+(.+)/);
          if (match) this.setAccountStep(account, match[1], match[2].trim());
        }
      });

      const cancelKey = `python-${account.line ?? account.email}`;
      job._pythonChildren = job._pythonChildren || new Map();
      job._pythonChildren.set(cancelKey, child);
    });

    try {
      const stdout = await childPromise;
      // Last JSON line wins (upstream may print noise)
      const lines = String(stdout || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      let automationResult = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          automationResult = JSON.parse(lines[i]);
          break;
        } catch {
          /* continue */
        }
      }
      if (!automationResult) {
        throw new Error(`No JSON result from grokreg: ${String(stdout).slice(0, 200)}`);
      }

      if (automationResult.status === "success") {
        account.email = automationResult.email || account.email;
        if (!automationResult.access_token || !automationResult.refresh_token) {
          this.finalizeAccount(account, "failed", {
            error:
              "Register OK but CPA mint missing tokens — no grok-cli credentials. Check Turnstile/proxy.",
            step: "cpa_mint_missing_tokens",
            message: "CPA mint did not return access_token/refresh_token",
          });
          await this.persistJobSnapshot(job, { forcePreview: true });
          return "done";
        }

        this.setAccountStep(account, "saving_connection", "Saving grok-cli OAuth");
        await this.persistJobSnapshot(job, { forcePreview: true });
        const connection = await saveGrokCliConnection({
          email: automationResult.email,
          password: automationResult.password,
          sso: automationResult.sso,
          accessToken: automationResult.access_token,
          refreshToken: automationResult.refresh_token,
        });
        await assertConnectionPersisted(connection);

        this.finalizeAccount(account, "success", {
          connectionId: connection.id,
          step: "connection_saved",
          message: `grok-cli saved ${automationResult.email}`,
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        return "done";
      }

      if (automationResult.status === "needs_retry") {
        this.setAccountStep(
          account,
          "register_retry",
          `Python: ${automationResult.error || "needs retry"}`
        );
        await this.persistJobSnapshot(job, { forcePreview: false });
        return "needs_retry";
      }

      if (automationResult.status === "cancelled") {
        this.finalizeAccount(account, "cancelled", {
          error: automationResult.error || "cancelled",
          step: "cancelled",
        });
        await this.persistJobSnapshot(job, { forcePreview: true });
        return "done";
      }

      this.finalizeAccount(account, "failed", {
        error: automationResult.error || "Grok register failed",
        step: "register_failed",
        message: automationResult.error || "Grok register failed",
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return "done";
    } catch (error) {
      this.finalizeAccount(account, "failed", {
        error: `Python error: ${error.message}`,
        step: "python_subprocess_failed",
        message: error.message,
      });
      await this.persistJobSnapshot(job, { forcePreview: true });
      return "done";
    } finally {
      if (job._pythonChildren) {
        const cancelKey = `python-${account.line ?? account.email}`;
        const child = job._pythonChildren.get(cancelKey);
        if (child && !child.killed && child.exitCode === null) child.kill("SIGTERM");
        job._pythonChildren.delete(cancelKey);
      }
    }
  }
}

function getSingletonStore() {
  if (!globalThis.__grokBulkImportSingleton) {
    globalThis.__grokBulkImportSingleton = {
      manager: new GrokBulkImportManager(),
    };
  }
  return globalThis.__grokBulkImportSingleton;
}

export function getGrokBulkImportManager() {
  return getSingletonStore().manager;
}

export { buildLookupResponse };
