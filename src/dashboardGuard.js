import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER);
  if (!token) return false;
  return token === await getCliToken();
}

const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
];

const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/keys",
  "/api/providers/client",
  "/api/provider-nodes/validate",
];

const V1_API_PREFIXES = ["/v1", "/api/v1", "/codex"];

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  return false;
}

function isBrowserRequest(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  return accept.includes("text/html");
}

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (await hasValidCliToken(request) || await hasValidToken(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (PROTECTED_API_PATHS.some((p) => pathname.startsWith(p))) {
    if (pathname === "/api/settings/require-login") return NextResponse.next();
    if (await hasValidCliToken(request) || await isAuthenticated(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // /v1/* and /api/v1/* - block browser, handler enforces requireApiKey
  if (V1_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (isBrowserRequest(request)) {
      return new NextResponse(null, { status: 404 });
    }
    return NextResponse.next();
  }

  // /masuk - redirect to dashboard if already authenticated
  if (pathname === "/masuk" || pathname === "/masuk/") {
    if (await isAuthenticated(request)) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  }

  // /login - always redirect to /masuk
  if (pathname === "/login" || pathname === "/login/") {
    return NextResponse.redirect(new URL("/masuk", request.url));
  }

  // / - redirect to dashboard if authenticated, otherwise return JSON welcome
  if (pathname === "/") {
    if (await isAuthenticated(request)) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    const host = request.headers.get("host") || "api.bevansatria.my.id";
    const protocol = request.headers.get("x-forwarded-proto") || "https";
    const baseUrl = `${protocol}://${host}`;

    return new NextResponse(
      JSON.stringify({
        message: `Welcome to VansAI! Use ${baseUrl}/v1 as your API endpoint.`,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/masuk", request.url));
          }
        }
      }
    } catch {}

    if (!requireLogin) return NextResponse.next();

    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return NextResponse.redirect(new URL("/masuk", request.url));
      }
    }

    return NextResponse.redirect(new URL("/masuk", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/masuk", "/login", "/dashboard/:path*", "/v1/:path*", "/v1", "/api/v1/:path*", "/api/v1", "/codex/:path*"],
};
