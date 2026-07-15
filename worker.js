const ORIGIN = "https://h2zv6r9d76-code.github.io";
const MAX_ITEMS_PER_SYNC = 500;
const MAX_CIPHERTEXT_CHARS = 1205000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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
function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
async function loginLock(db, ip) {
  const row = await db.prepare(
    "SELECT failed_count, locked_until FROM inventory_login_attempts WHERE ip_address = ?"
  ).bind(ip).first();
  if (row?.locked_until && row.locked_until > new Date().toISOString()) {
    return row.locked_until;
  }
  return null;
}
async function recordFailedLogin(db, ip) {
  const now = Date.now();
  const windowStart = new Date(now - 15 * 60 * 1000).toISOString();
  const existing = await db.prepare(
    "SELECT failed_count, first_failed_at FROM inventory_login_attempts WHERE ip_address = ?"
  ).bind(ip).first();
  const count = !existing || existing.first_failed_at < windowStart ? 1 : existing.failed_count + 1;
  // 失敗ごとに 2, 4, 8, 16 秒、5回目で15分間ロックする。
  const lockSeconds = count >= 5 ? 15 * 60 : 2 ** count;
  const firstFailedAt = count === 1 ? new Date(now).toISOString() : existing.first_failed_at;
  const lockedUntil = new Date(now + lockSeconds * 1000).toISOString();
  await db.prepare(
    "INSERT INTO inventory_login_attempts (ip_address, failed_count, first_failed_at, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(ip_address) DO UPDATE SET failed_count = excluded.failed_count, first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until"
  ).bind(ip, count, firstFailedAt, lockedUntil).run();
  return { count, lockedUntil };
}
function validEncryptedItem(item) {
  return item
    && item.encrypted === true
    && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 100
    && typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt))
    && typeof item.iv === "string" && item.iv.length <= 24 && BASE64.test(item.iv)
    && typeof item.ciphertext === "string" && item.ciphertext.length > 0 && item.ciphertext.length <= MAX_CIPHERTEXT_CHARS && BASE64.test(item.ciphertext);
}
function isEncryptedStoredItem(value) {
  try { return JSON.parse(value)?.encrypted === true; }
  catch { return false; }
}
async function ensureSchema(db) {
  await db.exec("CREATE TABLE IF NOT EXISTS inventory_items (id TEXT PRIMARY KEY, item_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
  await db.exec("CREATE TABLE IF NOT EXISTS inventory_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL)");
  await db.exec("CREATE TABLE IF NOT EXISTS inventory_login_attempts (ip_address TEXT PRIMARY KEY, failed_count INTEGER NOT NULL, first_failed_at TEXT NOT NULL, locked_until TEXT NOT NULL)");
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
        const ip = clientIp(request);
        const lockedUntil = await loginLock(env.DB, ip);
        if (lockedUntil) return reply("ログイン試行が多すぎます。しばらく待ってから再試行してください", 429, { "Retry-After": String(Math.ceil((new Date(lockedUntil) - Date.now()) / 1000)) });
        if (typeof body.password !== "string" || body.password.length < 16 || body.password.length > 1024 || body.password !== env.APP_PASSWORD) {
          const failure = await recordFailedLogin(env.DB, ip);
          const message = failure.count >= 5
            ? "ログイン試行が多すぎます。15分後に再試行してください"
            : `パスワードが正しくありません。${2 ** failure.count}秒待ってから再試行してください`;
          return reply(message, 401, { "Retry-After": String(Math.max(0, Math.ceil((new Date(failure.lockedUntil) - Date.now()) / 1000))) });
        }
        await env.DB.prepare("DELETE FROM inventory_login_attempts WHERE ip_address = ?").bind(ip).run();
        const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
        await env.DB.prepare("INSERT INTO inventory_sessions (token_hash, expires_at) VALUES (?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at").bind(await sha256(token), expiresAt).run();
        return reply(JSON.stringify({ token }), 200, { "Content-Type": "application/json" });
      }
      if (path !== "/v1/sync") return reply("Not found", 404);
      await requireSession(request, env.DB);
      if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS_PER_SYNC || body.items.some(item => !validEncryptedItem(item))) return reply("Invalid encrypted items", 400);
      for (const item of body.items) {
        const existing = await env.DB.prepare("SELECT updated_at, item_json FROM inventory_items WHERE id = ?").bind(item.id).first();
        if (!existing || item.updatedAt > existing.updated_at || !isEncryptedStoredItem(existing.item_json)) {
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
