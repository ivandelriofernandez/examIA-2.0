import { kv, signSession } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const token = req.body && req.body.token;
  if (!token) return res.status(400).json({ error: "Falta el token" });
  let email;
  try {
    email = await kv(["GET", "examia:login:" + token]);
    if (email) await kv(["DEL", "examia:login:" + token]); // one-time use
  } catch (e) { return res.status(500).json({ error: "config" }); }
  if (!email) return res.status(401).json({ error: "Enlace caducado o inválido" });
  return res.status(200).json({ email, session: signSession(email) });
}
