import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { PROVIDERS } from "../config/providers.js";
import { PROVIDER_MODELS } from "../config/providerModels.js";

const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";

function signHeaders(extra = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex");
  return {
    accept: "*/*",
    "content-type": "application/json",
    origin: "https://autoclaw.z.ai",
    referer: "https://autoclaw.z.ai/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "x-auth-appid": APP_ID,
    "x-auth-timestamp": ts,
    "x-auth-sign": sign,
    "x-product": "autoclaw",
    "x-version": "1.12.1",
    "x-tm": "web",
    "x-channel": "official",
    "x-client-type": "web",
    "x-lang": "zh-CN",
    "x-trace-id": crypto.randomUUID(),
    ...extra,
  };
}

function resolveUpstreamModel(model) {
  const models = PROVIDER_MODELS["ac"] || PROVIDER_MODELS["autoclaw"] || [];
  const match = models.find((m) => m.id === model || m.alias === model);
  return match?.upstreamModelId || model;
}

export class AutoclawExecutor extends DefaultExecutor {
  constructor() {
    super("autoclaw", PROVIDERS.autoclaw || { baseUrl: "", headers: {} });
    this._currentModel = null;
  }

  buildHeaders(credentials, stream) {
    const token = credentials?.accessToken;
    if (!token) {
      throw new Error("autoclaw: missing accessToken");
    }
    const rawToken = token.replace(/^Bearer\s+/i, "");
    const extras = {
      "X-Authorization": rawToken,
      "X-Request-Id": crypto.randomUUID(),
      Accept: stream ? "text/event-stream" : "*/*",
    };
    if (this._currentModel) {
      extras["X-Request-Model"] = resolveUpstreamModel(this._currentModel);
    }
    return signHeaders(extras);
  }

  // Proxy routes via X-Request-Model header — omit model from body to avoid
  // misleading "非法模型" error on 0-balance accounts (proxy returns proper
  // "积分不足" when body lacks model field).
  transformRequest(model, body, _stream, _credentials) {
    const { model: _, ...rest } = body;
    return { ...rest, stream: true };
  }

  async execute(args) {
    this._currentModel = args.model;
    try {
      return await super.execute(args);
    } finally {
      this._currentModel = null;
    }
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    const { refreshAutoclawToken } = await import("../services/tokenRefresh/autoclaw.js");
    return refreshAutoclawToken(credentials, log, proxyOptions);
  }

  needsRefresh(credentials) {
    if (!credentials?.expiresAt) return true;
    const expiresAtMs = Date.parse(credentials.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return true;
    return expiresAtMs - Date.now() < 60 * 60 * 1000;
  }
}

export default AutoclawExecutor;
