// Cloudflare Worker: holds your Anthropic API key so the public page never sees it.
// It only forwards chat requests from your own site, pins the model, caps the
// response size, and limits how many requests each visitor (and everyone together)
// can make per day. Set a hard monthly spend limit in the Claude Console as well.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const reply = (status, obj) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);

    // Tobler: read-only calls to the AI Living World Atlas, with the atlas key added here so the
    // page never sees it. Its own daily counter, because one map search makes up to ~20 atlas calls.
    if (request.method === "POST" && url.pathname === "/atlas") {
      if (!okOrigin) return reply(403, { message: "This endpoint only serves the demo site." });
      const ATLAS_TOOLS = new Set(["find_datasets", "get_dataset", "fetch_features", "vocabulary"]);
      let call;
      try { call = JSON.parse(await request.text()); } catch { return reply(400, { message: "Bad request" }); }
      if (call?.method !== "tools/call" || !ATLAS_TOOLS.has(call?.params?.name)) return reply(403, { message: "Not allowed" });
      const day = new Date().toISOString().slice(0, 10);
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const key = `atlas:${day}:${ip}`;
      const used = +(await env.LIMITS.get(key)) || 0;
      if (used >= +(env.ATLAS_PER_VISITOR_DAILY || 2000)) return reply(429, { message: "You've reached today's limit for map searches." });
      const upstream = await fetch("https://atlas-mcp.robdunfey.workers.dev/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.ATLAS_MCP_KEY}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: call.id ?? 1, method: "tools/call", params: { name: call.params.name, arguments: call.params.arguments || {} } }),
      });
      await env.LIMITS.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
      return new Response(upstream.body, { status: upstream.status, headers: { ...cors, "content-type": "application/json" } });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/messages") return reply(404, { message: "Not found" });
    if (!okOrigin) return reply(403, { message: "This endpoint only serves the demo site." });

    const raw = await request.text();
    if (raw.length > 120_000) return reply(413, { message: "Conversation too long. Start a new chat." });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { message: "Bad request" });
    }

    // Daily limits, per visitor and overall.
    const day = new Date().toISOString().slice(0, 10);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const perIpKey = `ip:${day}:${ip}`;
    const totalKey = `all:${day}`;
    const [ipCount, total] = await Promise.all([
      env.LIMITS.get(perIpKey).then((v) => +v || 0),
      env.LIMITS.get(totalKey).then((v) => +v || 0),
    ]);
    if (ipCount >= +env.PER_VISITOR_DAILY) {
      return reply(429, { message: "You've reached today's limit for the free demo." });
    }
    if (total >= +env.TOTAL_DAILY) {
      return reply(429, { message: "The demo has reached its daily limit." });
    }

    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.MODEL,
        // Haiku thinks before it writes code, so leave room for both.
        max_tokens: Math.min(+body.max_tokens || 4000, +env.MAX_TOKENS || 8000),
        system: body.system,
        messages: body.messages,
        tools: body.tools,
      }),
    });

    // KV is eventually consistent, so these counts are approximate. That's fine here.
    await Promise.all([
      env.LIMITS.put(perIpKey, String(ipCount + 1), { expirationTtl: 60 * 60 * 26 }),
      env.LIMITS.put(totalKey, String(total + 1), { expirationTtl: 60 * 60 * 26 }),
    ]);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "content-type": "application/json" },
    });
  },
};
