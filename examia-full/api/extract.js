import { HAIKU, PER_IP_LIMIT, GLOBAL_CAP, identityKey, getCountsForKey, callClaude, verifySession, emailSubscribed } from "./_lib.js";

async function extract(base64) {
  const data = await callClaude({
    model: HAIKU, max_tokens: 8000,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
      { type: "text", text: "Extrae todo el contenido textual de este documento PDF manteniendo la estructura (titulos, secciones, parrafos, listas). Devuelve unicamente el texto extraido, sin comentarios ni explicaciones." }
    ] }]
  });
  return (data.content.find(b => b.type === "text") || {}).text || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { base64, session } = req.body || {};
  if (!base64) return res.status(400).json({ error: "Falta el PDF" });
  const email = verifySession(session);

  try { if (email && await emailSubscribed(email)) return res.status(200).json({ text: await extract(base64) }); } catch (e) {}

  let counts;
  try { counts = await getCountsForKey(identityKey(req, email)); }
  catch (e) { return res.status(500).json({ error: "config", message: e.message }); }
  if (counts.globalCount >= GLOBAL_CAP) return res.status(429).json({ error: "global", message: "El cupo gratuito mensual se ha agotado." });
  if (counts.idCount >= PER_IP_LIMIT) return res.status(429).json({ error: "limit", remaining: 0 });

  try { return res.status(200).json({ text: await extract(base64) }); }
  catch (e) { return res.status(500).json({ error: "extract", message: e.message }); }
}
