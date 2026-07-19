import { describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ execute }),
}));

const {
  default: adapter,
  collectGrokCliImages,
  extractGrokCliImages,
} = await import("open-sse/handlers/imageProviders/grok-cli.js");

describe("grok-cli image provider", () => {
  it("extracts base64 and data URL image results", () => {
    expect(extractGrokCliImages({
      output: [
        { type: "message", content: [] },
        { type: "image_generation_call", result: "data:image/jpeg;base64,/9j-test" },
        { type: "image_generation_call", result: { base64: "raw-test" } },
      ],
    })).toEqual(["/9j-test", "raw-test"]);
  });

  it("uses non-streaming image tool requests and caps n at four", async () => {
    execute.mockResolvedValue({
      response: new Response(JSON.stringify({
        output: [{ type: "image_generation_call", result: "image-data" }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }), { status: 200 }),
    });

    const result = await adapter.executeViaExecutor(
      "grok-4.5",
      { prompt: "red apple", n: 9, size: "1024x1024", quality: "high" },
      { accessToken: "test-token" },
    );

    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[0][0]).toMatchObject({
      model: "grok-4.5",
      stream: false,
      body: {
        stream: false,
        tools: [{ type: "image_generation", size: "1024x1024", quality: "high" }],
      },
    });
    expect(result.data).toHaveLength(4);
    expect(result.usage).toEqual({ input_tokens: 8, output_tokens: 12, total_tokens: 20 });
  });

  it("normalizes edit references and sends input_image items", async () => {
    execute.mockResolvedValue({
      response: new Response(JSON.stringify({
        output: [{ type: "image_generation_call", result: "edited-image" }],
      }), { status: 200 }),
    });

    expect(collectGrokCliImages({ b64_json: "source" }, ["https://example.com/source.png"], 3)).toEqual([
      "data:image/png;base64,source",
      "https://example.com/source.png",
    ]);

    await adapter.executeViaExecutor(
      "grok-4.5",
      { prompt: "make sky purple", image: "data:image/png;base64,source", edit: true },
      { accessToken: "test-token" },
    );

    expect(execute.mock.calls[0][0].body.input[0].content).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,source" },
      { type: "input_text", text: "Edit this image: make sky purple. Use the image_generation tool." },
    ]);
  });

  it("fails cleanly when upstream returns no image call", async () => {
    execute.mockResolvedValue({
      response: new Response(JSON.stringify({ output: [{ type: "message" }] }), { status: 200 }),
    });

    await expect(adapter.executeViaExecutor(
      "grok-4.5",
      { prompt: "red apple" },
      { accessToken: "test-token" },
    )).rejects.toThrow("image_generation_call");
  });
});
