const ORIGIN = "https://h2zv6r9d76-code.github.io";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function reply(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...corsHeaders(), ...headers } });
}
async function sha256(value) {
  const data = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(data)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function requireSession(request, db) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/, "");
  if (!token) throw new Error("ログインが必要です");
  const row = await db.prepare("SELECT expires_at FROM inventory_sessions WHERE token_hash = ?").bind(await sha256(token)).first();
  if (!row || row.expires_at < new Date().toISOString()) throw new Error("ログインの有効期限が切れました");
}
function validItem(item) {
  return item && typeof item.id === "string" && typeof item.name === "string" && typeof item.updatedAt === "string";
}
async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS inventory_items (id TEXT PRIMARY KEY, item_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
  await db.exec("CREATE TABLE IF NOT EXISTS inventory_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL)");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return reply(null, 204);
    if (request.method !== "POST") return reply("Not found", 404);
    try {
      const path = new URL(request.url).pathname;
      await ensureSchema(env.DB);
      const body = await request.json();
      if (path === "/v1/login") {
        if (!env.APP_PASSWORD) return reply("ログイン設定が未完了です", 503);
        if (typeof body.password !== "string" || body.password.length < 16 || body.password !== env.APP_PASSWORD) return reply("パスワードが正しくありません", 401);
        const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare("INSERT INTO inventory_sessions (token_hash, expires_at) VALUES (?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at").bind(await sha256(token), expiresAt).run();
        return reply(JSON.stringify({ token }), 200, { "Content-Type": "application/json" });
      }
      if (path !== "/v1/sync") return reply("Not found", 404);
      await requireSession(request, env.DB);
      if (!Array.isArray(body.items) || body.items.some(item => !validItem(item))) return reply("Invalid items", 400);
      for (const item of body.items) {
        const existing = await env.DB.prepare("SELECT updated_at FROM inventory_items WHERE id = ?").bind(item.id).first();
        if (!existing || item.updatedAt > existing.updated_at) {
          await env.DB.prepare("INSERT INTO inventory_items (id, item_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET item_json = excluded.item_json, updated_at = excluded.updated_at").bind(item.id, JSON.stringify(item), item.updatedAt).run();
        }
      }
      const { results } = await env.DB.prepare("SELECT item_json FROM inventory_items ORDER BY updated_at DESC").all();
      return reply(JSON.stringify({ items: results.map(row => JSON.parse(row.item_json)) }), 200, { "Content-Type": "application/json" });
    } catch (error) {
      return reply(error.message || "Unauthorized", 403, { "Content-Type": "text/plain" });
    }
  },
};
