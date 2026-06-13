// Curated "suggested" models for providers that don't expose a public
// modelsFetcher endpoint. Surfaced in the provider page's
// "Suggested free models" section so users can one-click add them.
//
// Keyed by providerId. Each entry: { id, name }.
// NVIDIA NIM: all listed models are free for NVIDIA Developer Program members
// (prototyping/testing). The list below was verified reachable against
// integrate.api.nvidia.com — fast, good-quality general/coding models.
export const SUGGESTED_MODELS = {
  nvidia: [
    { id: "z-ai/glm-5.1", name: "GLM 5.1" },
    { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
    { id: "qwen/qwen3.5-397b-a17b", name: "Qwen3.5 397B A17B" },
    { id: "qwen/qwen3.5-122b-a10b", name: "Qwen3.5 122B A10B" },
    { id: "qwen/qwen3-next-80b-a3b-instruct", name: "Qwen3 Next 80B A3B" },
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B" },
    { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B" },
    { id: "meta/llama-4-maverick-17b-128e-instruct", name: "Llama 4 Maverick 17B" },
    { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B" },
    { id: "mistralai/mistral-large-3-675b-instruct-2512", name: "Mistral Large 3 675B" },
    { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", name: "Nemotron Super 49B v1.5" },
    { id: "stepfun-ai/step-3.7-flash", name: "Step 3.7 Flash" },
  ],
};
