import { verifySession, emailSubscribed, getIp, currentMonth, kv, PER_IP_LIMIT, GLOBAL_CAP } from "./_lib.js";

export default async function handler(req, res) {
  const email = verifySession(req.query.session || "");
  let subscribed = false;
  if (email) { try { subscribed = await emailSubscribed(email); } catch {} }

  let remaining = 0;
  try {
    const month = currentMonth();
    const globalCount = parseInt((await kv(["GET", "examia:global:" + month])) || "0", 10);
    const idKey = (email ? "examia:user:" + email : "examia:ip:" + getIp(req)) + ":" + month;
    const used = parseInt((await kv(["GET", idKey])) || "0", 10);
    remaining = globalCount >= GLOBAL_CAP ? 0 : Math.max(0, PER_IP_LIMIT - used);
  } catch {}

  return res.status(200).json({ email: email || null, subscribed, remaining });
}
