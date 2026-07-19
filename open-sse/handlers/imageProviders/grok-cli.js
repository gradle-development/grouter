import { nowSec } from "./_base.js";
import { getExecutor } from "../../executors/index.js";

function stripDataUrl(value) {
  const text = String(value || "").trim();
  return text.startsWith("data:") && text.includes(",") ? text.split(",", 2)[1] : text;
}

export function extractGrokCliImages(responseBody) {
  const images = [];
  for (const item of responseBody?.output || []) {
    if (item?.type !== "image_generation_call") continue;
    const raw = typeof item.result === "object" && item.result !== null
      ? item.result.b64_json || item.result.base64 || item.result.data
      : item.result || item.image;
    const b64 = stripDataUrl(raw);
    if (b64) images.push(b64);
  }
  return images;
}

export function normalizeGrokCliImage(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    if (value.url) return normalizeGrokCliImage(value.url);
    if (value.image_url) return normalizeGrokCliImage(value.image_url);
    const raw = value.b64_json || value.base64 || value.data;
    return raw ? `data:image/png;base64,${stripDataUrl(raw)}` : null;
  }

  const text = String(value).trim();
  if (!text) return null;
  if (/^(data:image\/|https?:\/\/)/i.test(text)) return text;
  return `data:image/png;base64,${stripDataUrl(text)}`;
}

export function collectGrokCliImages(image, images, maxRefs = 3) {
  const values = image != null ? [image] : [];
  if (Array.isArray(images)) values.push(...images);
  else if (images != null) values.push(images);
  return values.map(normalizeGrokCliImage).filter(Boolean).slice(0, maxRefs);
}

function buildRequest(model, body) {
  const tool = { type: "image_generation" };
  if (body.size) tool.size = body.size;
  if (body.quality) tool.quality = body.quality;
  const refs = collectGrokCliImages(body.image || body.image_url, body.images);
  if (body.edit && refs.length === 0) {
    const error = new Error("image is required");
    error.status = 400;
    throw error;
  }

  return {
    model,
    input: [{
      role: "user",
      content: [
        ...refs.map((image_url) => ({ type: "input_image", image_url })),
        {
          type: "input_text",
          text: `${body.edit ? "Edit this image" : "Generate an image"}: ${body.prompt}. Use the image_generation tool.`,
        },
      ],
    }],
    tools: [tool],
    stream: false,
    store: false,
    reasoning: { effort: "low" },
    max_output_tokens: 1024,
  };
}

export default {
  useExecutor: true,
  buildUrl: () => "",
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log) {
    const executor = getExecutor("grok-cli");
    if (!executor) throw new Error("Grok CLI executor not found");

    const count = Math.max(1, Math.min(Number.parseInt(body.n, 10) || 1, 4));
    const data = [];
    const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

    for (let i = 0; i < count; i += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Grok CLI image generation timeout")), 180_000);
      let result;
      try {
        result = await executor.execute({
          model,
          body: buildRequest(model, body),
          stream: false,
          credentials,
          signal: controller.signal,
          proxyOptions: credentials?.providerSpecificData,
          log,
        });
      } catch (error) {
        if (controller.signal.aborted) error.status = 504;
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (!result.response.ok) {
        const text = await result.response.text();
        throw new Error(text || `HTTP ${result.response.status}`);
      }

      const responseBody = await result.response.json();
      const images = extractGrokCliImages(responseBody);
      if (!images.length) throw new Error("Grok CLI did not return an image_generation_call");
      data.push(...images.map((b64_json) => ({ b64_json })));

      const itemUsage = responseBody.usage || {};
      const inputTokens = Number(itemUsage.input_tokens) || 0;
      const outputTokens = Number(itemUsage.output_tokens) || 0;
      usage.input_tokens += inputTokens;
      usage.output_tokens += outputTokens;
      usage.total_tokens += Number(itemUsage.total_tokens) || inputTokens + outputTokens;
    }

    return { created: nowSec(), data, usage };
  },

  normalize: (responseBody) => responseBody,
};
