import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";

/**
 * POST /api/oauth/grok-cli/import-token
 * Body: { accessToken, refreshToken, email? }
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const accessToken = String(body?.accessToken || body?.access_token || "").trim();
    const refreshToken = String(body?.refreshToken || body?.refresh_token || "").trim();
    const email = String(body?.email || "").trim();

    if (!accessToken || !refreshToken) {
      return NextResponse.json(
        { error: "accessToken and refreshToken are required" },
        { status: 400 }
      );
    }

    const connection = await createProviderConnection({
      provider: "grok-cli",
      authType: "oauth",
      name: email || `grok-cli-${accessToken.slice(0, 8)}`,
      email: email || undefined,
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      testStatus: "active",
      isActive: true,
      providerSpecificData: {
        automation: "manual-token-import",
        importedAt: new Date().toISOString(),
      },
    });

    const result = { ...connection };
    delete result.accessToken;
    delete result.refreshToken;
    delete result.apiKey;

    return NextResponse.json({ success: true, connection: result }, { status: 201 });
  } catch (error) {
    console.log("grok-cli import-token error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import grok-cli token" },
      { status: 500 }
    );
  }
}
