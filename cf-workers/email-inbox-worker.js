// Cloudflare Email Routing Inbox Worker
// Catch-all email inbox via Email Routing + KV.
// Deploy: wrangler deploy
// Set route: catch-all *@yourdomain.com → this worker
//
// API:
//   GET  /api/address             → {address:"cf-xxx@yourdomain.com"}
//   GET  /api/messages?addr=xxx   → [{from,subject,text,receivedAt}]
//  POST  /api/messages/:id/raw    → {html} (fetch full HTML body)
// DELETE /api/messages?addr=xxx   → clear inbox for addr

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomLocal() {
  let s = "cf";
  for (let i = 0; i < 12; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export default {
  async email(message, env, ctx) {
    const to = message.to.toLowerCase();
    const text = typeof message.text === "function" ? await message.text() : String(await message.text ?? "");
    const html = text; // fallback, Email Routing provides text
    const headers = {};
    message.headers.forEach((val, key) => { headers[key] = val; });
    const entry = {
      from: message.from,
      to,
      subject: message.subject || "",
      text: text || "",
      html: html || "",
      receivedAt: new Date().toISOString(),
      headers,
    };
    // Append to KV list for this address
    const key = `inbox:${to}`;
    const existing = await env.INBOX.get(key, "text");
    const list = existing ? JSON.parse(existing) : [];
    list.push(entry);
    // Keep max 50 per address (KV 1MB limit)
    if (list.length > 50) list.shift();
    await env.INBOX.put(key, JSON.stringify(list));
    ctx.waitUntil(Promise.resolve());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "GET" && url.pathname === "/api/address") {
      const local = url.searchParams.get("local") || randomLocal();
      const domain = env.DOMAIN || url.searchParams.get("domain") || "tandatangan.io";
      const address = `${local}@${domain}`;
      return Response.json({ address });
    }

    if (url.pathname === "/api/messages") {
      const addr = url.searchParams.get("addr") || "";
      if (!addr) return Response.json({ error: "missing addr" }, { status: 400 });

      if (method === "GET") {
        const key = `inbox:${addr.toLowerCase()}`;
        const raw = await env.INBOX.get(key, "text");
        const list = raw ? JSON.parse(raw) : [];
        return Response.json(list);
      }

      if (method === "DELETE") {
        const key = `inbox:${addr.toLowerCase()}`;
        await env.INBOX.delete(key);
        return Response.json({ ok: true });
      }
    }

    if (method === "POST" && url.pathname.startsWith("/api/messages/") && url.pathname.endsWith("/raw")) {
      const idx = parseInt(url.pathname.split("/")[3], 10);
      const addr = url.searchParams.get("addr") || "";
      if (!addr) return Response.json({ error: "missing addr" }, { status: 400 });
      const key = `inbox:${addr.toLowerCase()}`;
      const raw = await env.INBOX.get(key, "text");
      const list = raw ? JSON.parse(raw) : [];
      if (idx < 0 || idx >= list.length) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ html: list[idx].html || list[idx].text || "" });
    }

    return new Response("not found", { status: 404 });
  },
};
