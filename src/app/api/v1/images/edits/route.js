import { handleImageGeneration } from "@/sse/handlers/imageGeneration.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/images/edits - JSON OpenAI-compatible image edit endpoint */
export async function POST(request) {
  const body = await request.clone().json().catch(() => null);
  if (!body || (!body.image && !body.image_url && !body.images)) {
    return new Response(JSON.stringify({ error: "image is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  return handleImageGeneration(new Request(request, {
    body: JSON.stringify({ ...body, edit: true }),
    headers,
  }));
}
