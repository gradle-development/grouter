import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createProviderConnection } from "@/models";

const execFileAsync = promisify(execFile);
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const TIMEOUT_MS = 8 * 60_000;

function normalizeSso(raw) {
  let token = String(raw || "").trim();
  if (token.startsWith("sso=")) token = token.slice(4);
  return token.trim();
}

function parsePythonJson(stdout) {
  const lines = String(stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* continue */
    }
  }
  return null;
}

/**
 * POST /api/oauth/grok-cli/import-sso
 * Body: { email, password, sso, proxy? }
 * Mints CPA OAuth via python -m grokreg mint-sso, saves grok-cli connection.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const email = String(body?.email || "").trim();
    const password = String(body?.password || "");
    const sso = normalizeSso(body?.sso || body?.ssoCookie || "");
    const proxy = String(body?.proxy || body?.proxyUrl || "").trim();

    if (!email || !password || !sso) {
      return NextResponse.json(
        { error: "email, password, and sso are required" },
        { status: 400 }
      );
    }

    const scriptDir = path.join(process.cwd(), "scripts", "python");
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
    if (proxy) args.push("--proxy", proxy);

    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(PYTHON_BIN, args, {
        cwd: scriptDir,
        env: {
          ...process.env,
          PYTHONPATH: scriptDir,
          PYTHONUNBUFFERED: "1",
        },
        timeout: TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      });
      stdout = result.stdout || "";
      stderr = result.stderr || "";
    } catch (err) {
      stdout = err?.stdout || "";
      stderr = err?.stderr || "";
      if (!String(stdout).trim().startsWith("{") && !String(stdout).includes("{")) {
        return NextResponse.json(
          {
            error:
              err?.killed
                ? `Mint timed out after ${TIMEOUT_MS}ms`
                : `Mint failed: ${String(stderr || stdout || err.message).slice(0, 400)}`,
          },
          { status: 500 }
        );
      }
    }

    const mint = parsePythonJson(stdout);
    if (!mint) {
      return NextResponse.json(
        { error: `No JSON from grokreg mint-sso: ${String(stdout || stderr).slice(0, 300)}` },
        { status: 500 }
      );
    }
    if (mint.status !== "success" || !mint.access_token || !mint.refresh_token) {
      return NextResponse.json(
        { error: mint.error || "CPA mint did not return access_token/refresh_token" },
        { status: 400 }
      );
    }

    const connection = await createProviderConnection({
      provider: "grok-cli",
      authType: "oauth",
      name: mint.email || email,
      email: mint.email || email,
      accessToken: mint.access_token,
      refreshToken: mint.refresh_token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      testStatus: "active",
      isActive: true,
      providerSpecificData: {
        automation: "manual-sso-import",
        sso: normalizeSso(mint.sso || sso),
        password: password || undefined,
        importedAt: new Date().toISOString(),
      },
    });

    const result = { ...connection };
    delete result.accessToken;
    delete result.refreshToken;
    delete result.apiKey;

    return NextResponse.json({ success: true, connection: result }, { status: 201 });
  } catch (error) {
    console.log("grok-cli import-sso error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import grok-cli from SSO" },
      { status: 500 }
    );
  }
}
