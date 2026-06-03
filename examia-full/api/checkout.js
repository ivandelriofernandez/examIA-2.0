import { getOrigin, verifySession } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) return res.status(500).json({ error: "Pagos no configurados" });
  const email = verifySession(req.body && req.body.session);
  if (!email) return res.status(401).json({ error: "Debes iniciar sesión para suscribirte" });

  const origin = getOrigin(req);
  const params = new URLSearchParams();
  params.append("mode", "subscription");
  params.append("line_items[0][price]", process.env.STRIPE_PRICE_ID);
  params.append("line_items[0][quantity]", "1");
  params.append("customer_email", email);
  params.append("success_url", origin + "/?checkout=success");
  params.append("cancel_url", origin + "/?checkout=cancel");
  params.append("allow_promotion_codes", "true");

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await r.json();
  if (!r.ok) return res.status(500).json({ error: (data.error && data.error.message) || "Error de Stripe" });
  return res.status(200).json({ url: data.url });
}
