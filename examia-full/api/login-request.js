import { getOrigin, randomToken, kv, sendMagicLink } from "./_lib.js";

function validEmail(e) { return typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const email = (req.body && req.body.email || "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Email no válido" });
  if (!process.env.RESEND_API_KEY || !process.env.AUTH_SECRET) return res.status(500).json({ error: "Login no configurado" });

  const token = randomToken(24);
  try {
    await kv(["SET", "examia:login:" + token, email]);
    await kv(["EXPIRE", "examia:login:" + token, 900]); // 15 min
  } catch (e) { return res.status(500).json({ error: "config", message: e.message }); }

  const link = getOrigin(req) + "/?login=" + token;
  try { await sendMagicLink(email, link); }
  catch (e) { return res.status(500).json({ error: "mail", message: e.message }); }

  return res.status(200).json({ ok: true });
}
