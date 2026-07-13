// DEBUG: manual trigger for grok-cli reactivation job.
// This endpoint is intentionally unauthenticated for local testing.
// Remove or guard before exposing to production.
import { runGrokCliReactivationTick } from "@/shared/services/grokCliReactivation.js";
import { getProviderConnections } from "@/lib/localDb.js";

function isLocalRequest(request) {
  const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLoopback = (h) => {
    if (!h) return false;
    const name = h.split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
    return LOOPBACK_HOSTS.has(name);
  };
  if (request.headers.get("x-9r-via-proxy")) return false;
  const realIp = request.headers.get("x-9r-real-ip");
  if (realIp) return isLoopback(realIp);
  if (!isLoopback(request.headers.get("host"))) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try { return isLoopback(new URL(origin).hostname); } catch { return false; }
  }
  return true;
}

async function isAuthorized(request) {
  const secret = process.env.GROK_REACTIVATION_SECRET;
  if (secret && secret.length >= 8) {
    return request.headers.get("x-grok-reactivation-secret") === secret;
  }
  // In dev/unsafe mode, also allow localhost if no secret is configured
  return isLocalRequest(request);
}

export async function POST(request) {
  if (!(await isAuthorized(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "true";

  // Direct DB sanity check
  const all = await getProviderConnections({ provider: "grok-cli", isActive: false });
  console.log("[DebugGrokReactivate] direct DB inactive grok-cli:", all.length);

  const t0 = Date.now();
  console.log("[DebugGrokReactivate] tick started, force=", force);
  try {
    await runGrokCliReactivationTick(undefined, force);
    console.log("[DebugGrokReactivate] tick finished");
    return Response.json({
      ok: true,
      message: "Grok CLI reactivation tick completed",
      durationMs: Date.now() - t0,
    });
  } catch (error) {
    console.error("[DebugGrokReactivate] tick error:", error);
    return Response.json(
      {
        ok: false,
        error: error?.message || String(error),
        durationMs: Date.now() - t0,
      },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  if (!(await isAuthorized(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json({
    message: "POST to /api/debug/grok-reactivate to run reactivation tick",
  });
}
