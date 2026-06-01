// Shared helpers for serverless functions (files starting with _ are not routes)

export const HAIKU = "claude-haiku-4-5-20251001";
export const PER_IP_LIMIT = 3;      // free exams per visitor per month
export const GLOBAL_CAP = 600;      // total FREE exams per month (does NOT limit subscribers)
export const SUB_CAP = 300;         // generous monthly cap per paying subscriber (anti-abuse)

export function getIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || "unknown";
}

export function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export function getOrigin(req) {
  if (req.headers.origin) return req.headers.origin;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return proto + "://" + req.headers.host;
}

// Upstash Redis REST: send a single command as a JSON array
export async function kv(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Redis no configurado");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  const data = await res.json();
  return data.result;
}

export async function getCounts(ip) {
  const month = currentMonth();
  const ipKey = "examia:ip:" + ip + ":" + month;
  const globalKey = "examia:global:" + month;
  const ipCount = parseInt((await kv(["GET", ipKey])) || "0", 10);
  const globalCount = parseInt((await kv(["GET", globalKey])) || "0", 10);
  return { ipKey, globalKey, ipCount, globalCount };
}

export async function incrCounts(ipKey, globalKey) {
  const ttl = 60 * 60 * 24 * 40;
  const newIp = await kv(["INCR", ipKey]);
  await kv(["EXPIRE", ipKey, ttl]);
  await kv(["INCR", globalKey]);
  await kv(["EXPIRE", globalKey, ttl]);
  return newIp;
}

// ── Subscriptions (Stripe via REST) ──
export async function stripeGet(path) {
  const r = await fetch("https://api.stripe.com/v1" + path, {
    headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY }
  });
  return { ok: r.ok, data: await r.json() };
}

// Returns true if subToken maps to an active Stripe subscription (cached 1h)
export async function checkSubscriber(subToken) {
  if (!subToken) return false;
  let subId;
  try { subId = await kv(["GET", "examia:sub:" + subToken]); } catch { return false; }
  if (!subId) return false;
  try { if ((await kv(["GET", "examia:subok:" + subToken])) === "1") return true; } catch {}
  const { ok, data } = await stripeGet("/subscriptions/" + subId);
  if (!ok) return false;
  const active = data.status === "active" || data.status === "trialing";
  if (active) {
    try { await kv(["SET", "examia:subok:" + subToken, "1"]); await kv(["EXPIRE", "examia:subok:" + subToken, 3600]); } catch {}
  }
  return active;
}

export async function subWithinCap(subToken) {
  const key = "examia:subuse:" + subToken + ":" + currentMonth();
  const used = parseInt((await kv(["GET", key])) || "0", 10);
  return used < SUB_CAP;
}
export async function subIncr(subToken) {
  const key = "examia:subuse:" + subToken + ":" + currentMonth();
  await kv(["INCR", key]);
  await kv(["EXPIRE", key, 60 * 60 * 24 * 40]);
}

// Call Claude with the OWNER's key (server-side, never exposed)
export async function callClaude(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e && e.error && e.error.message) || ("Error " + r.status));
  }
  return r.json();
}
