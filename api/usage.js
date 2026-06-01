import { PER_IP_LIMIT, GLOBAL_CAP, getIp, getCounts } from "./_lib.js";

export default async function handler(req, res) {
  const ip = getIp(req);
  try {
    const counts = await getCounts(ip);
    const globalExhausted = counts.globalCount >= GLOBAL_CAP;
    const remaining = globalExhausted ? 0 : Math.max(0, PER_IP_LIMIT - counts.ipCount);
    return res.status(200).json({ remaining, limit: PER_IP_LIMIT, globalExhausted });
  } catch (e) {
    // If Redis isn't set up yet, behave as if free tier is unavailable (BYOK only)
    return res.status(200).json({ remaining: 0, limit: PER_IP_LIMIT, error: "config" });
  }
}
