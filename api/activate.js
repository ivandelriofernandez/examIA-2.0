import crypto from "crypto";
import { kv, stripeGet } from "./_lib.js";

export default async function handler(req, res) {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ active: false });
  const { ok, data } = await stripeGet("/checkout/sessions/" + sessionId);
  if (!ok || data.payment_status !== "paid" || !data.subscription) {
    return res.status(200).json({ active: false });
  }
  const token = crypto.randomBytes(24).toString("hex");
  // token -> subscriptionId (long lived; status checked live against Stripe)
  await kv(["SET", "examia:sub:" + token, data.subscription]);
  return res.status(200).json({ active: true, token });
}
