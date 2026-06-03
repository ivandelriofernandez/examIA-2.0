import crypto from "crypto";

export const HAIKU = "claude-haiku-4-5-20251001";
export const PER_IP_LIMIT = 3;      // free exams per identity (email or IP) per month
export const GLOBAL_CAP = 600;      // total FREE exams per month (does NOT limit subscribers)
export const SUB_CAP = 300;         // monthly cap per paying subscriber (anti-abuse)

export function getIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || "unknown";
}
export function currentMonth() { return new Date().toISOString().slice(0, 7); }
export function getOrigin(req) {
  if (req.headers.origin) return req.headers.origin;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return proto + "://" + req.headers.host;
}
export function randomToken(n = 24) { return crypto.randomBytes(n).toString("hex"); }

// ── Redis (Upstash REST) ──
export async function kv(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Redis no configurado");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  return (await res.json()).result;
}

// ── Sessions (stateless, HMAC-signed) ──
export function signSession(email) {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const payload = email + "|" + exp;
  const sig = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("hex");
  return Buffer.from(payload + "|" + sig).toString("base64url");
}
export function verifySession(token) {
  if (!token || !process.env.AUTH_SECRET) return null;
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const parts = decoded.split("|");
    if (parts.length < 3) return null;
    const sig = parts.pop();
    const exp = parseInt(parts.pop(), 10);
    const email = parts.join("|");
    const expected = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(email + "|" + exp).digest("hex");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Date.now() > exp) return null;
    return email;
  } catch { return null; }
}

// ── Email (Resend) ──
export async function sendMagicLink(email, link) {
  const from = process.env.MAIL_FROM || "examIA <onboarding@resend.dev>";
  const html = '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
    '<h2 style="color:#0b0f1a">Entra en examIA</h2>' +
    '<p style="color:#444;font-size:15px">Haz clic en el botón para iniciar sesión:</p>' +
    '<p style="margin:24px 0"><a href="' + link + '" style="display:inline-block;background:#e8b84b;color:#0b0f1a;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px">Iniciar sesión →</a></p>' +
    '<p style="color:#999;font-size:13px">Si no has solicitado esto, ignora el correo. El enlace caduca en 15 minutos.</p></div>';
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject: "Tu acceso a examIA", html })
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || ("Error " + r.status)); }
  return true;
}

// ── Counters ──
export function identityKey(req, email) {
  return email ? ("examia:user:" + email) : ("examia:ip:" + getIp(req));
}
export async function getCountsForKey(idKey) {
  const month = currentMonth();
  const globalKey = "examia:global:" + month;
  const fullId = idKey + ":" + month;
  const idCount = parseInt((await kv(["GET", fullId])) || "0", 10);
  const globalCount = parseInt((await kv(["GET", globalKey])) || "0", 10);
  return { fullId, globalKey, idCount, globalCount };
}
export async function incrCounts(fullId, globalKey) {
  const ttl = 60 * 60 * 24 * 40;
  const n = await kv(["INCR", fullId]); await kv(["EXPIRE", fullId, ttl]);
  await kv(["INCR", globalKey]); await kv(["EXPIRE", globalKey, ttl]);
  return n;
}

// ── Stripe (REST) ──
export async function stripeGet(path) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY }
  });
  return { ok: r.ok, data: await r.json() };
}
// Is there an active Stripe subscription for this email? (cached 1h)
export async function emailSubscribed(email) {
  if (!email) return false;
  const cacheKey = "examia:subemail:" + email;
  try { if ((await kv(["GET", cacheKey])) === "1") return true; } catch {}
  const cust = await stripeGet("/customers?email=" + encodeURIComponent(email) + "&limit=10");
  if (!cust.ok) return false;
  for (const c of (cust.data.data || [])) {
    const subs = await stripeGet("/subscriptions?customer=" + c.id + "&status=all&limit=10");
    if (subs.ok && (subs.data.data || []).some(s => s.status === "active" || s.status === "trialing")) {
      try { await kv(["SET", cacheKey, "1"]); await kv(["EXPIRE", cacheKey, 3600]); } catch {}
      return true;
    }
  }
  return false;
}
export async function subWithinCap(email) {
  const key = "examia:subuse:" + email + ":" + currentMonth();
  return parseInt((await kv(["GET", key])) || "0", 10) < SUB_CAP;
}
export async function subIncr(email) {
  const key = "examia:subuse:" + email + ":" + currentMonth();
  await kv(["INCR", key]); await kv(["EXPIRE", key, 60 * 60 * 24 * 40]);
}

// ── Claude ──
export async function callClaude(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error((e && e.error && e.error.message) || ("Error " + r.status)); }
  return r.json();
}
