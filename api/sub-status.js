import { checkSubscriber } from "./_lib.js";

export default async function handler(req, res) {
  const token = req.query.token;
  if (!token) return res.status(200).json({ active: false });
  try { return res.status(200).json({ active: await checkSubscriber(token) }); }
  catch { return res.status(200).json({ active: false }); }
}
