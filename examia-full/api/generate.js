import { HAIKU, PER_IP_LIMIT, GLOBAL_CAP, identityKey, getCountsForKey, incrCounts, callClaude, verifySession, emailSubscribed, subWithinCap, subIncr } from "./_lib.js";

function buildPrompt(n, textContent) {
  const safeText = textContent.length > 12000 ? textContent.slice(0, 12000) : textContent;
  return "Basandote en el siguiente temario, genera exactamente " + n + " preguntas de examen tipo test en espanol. " +
    "Devuelve UNICAMENTE un array JSON valido, sin markdown ni texto extra. Cada elemento debe tener: " +
    '"question": string (pregunta completa), ' +
    '"options": array de exactamente 4 strings (sin letra de prefijo), ' +
    '"correct": number (indice 0-3 de la respuesta correcta), ' +
    '"explanation": string (explicacion breve). ' +
    "Varia los temas y la dificultad. Opciones incorrectas plausibles.\n\nTEMARIO:\n" + safeText;
}
async function generate(n, textContent) {
  const data = await callClaude({ model: HAIKU, max_tokens: 4096, messages: [{ role: "user", content: buildPrompt(n, textContent) }] });
  const raw = (data.content.find(b => b.type === "text") || {}).text || "[]";
  const parsed = JSON.parse(raw.replace(/^```json\s*|^```\s*|```\s*$/gm, "").trim());
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("Respuesta inesperada");
  return parsed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { textContent, numQ, session } = req.body || {};
  if (!textContent) return res.status(400).json({ error: "Falta el contenido del temario" });
  const n = Math.min(Math.max(parseInt(numQ) || 10, 1), 20);
  const email = verifySession(session);

  // Subscriber path (paid, by email)
  try {
    if (email && await emailSubscribed(email)) {
      if (!(await subWithinCap(email))) return res.status(429).json({ error: "subcap", message: "Has alcanzado el máximo mensual de tu plan." });
      const questions = await generate(n, textContent);
      await subIncr(email);
      return res.status(200).json({ questions, subscriber: true });
    }
  } catch (e) {}

  // Free tier (by email if logged in, else by IP)
  let counts;
  try { counts = await getCountsForKey(identityKey(req, email)); }
  catch (e) { return res.status(500).json({ error: "config", message: e.message }); }
  if (counts.globalCount >= GLOBAL_CAP) return res.status(429).json({ error: "global", message: "El cupo gratuito mensual se ha agotado." });
  if (counts.idCount >= PER_IP_LIMIT) return res.status(429).json({ error: "limit", remaining: 0 });

  try {
    const questions = await generate(n, textContent);
    const newCount = await incrCounts(counts.fullId, counts.globalKey);
    return res.status(200).json({ questions, remaining: Math.max(0, PER_IP_LIMIT - newCount) });
  } catch (e) { return res.status(500).json({ error: "generate", message: e.message }); }
}
