import { probeTranslationFailover } from '../lib/translation-failover.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const probe = await probeTranslationFailover();
  return res.status(probe.ok ? 200 : 503).json({
    ok: probe.ok,
    provider: probe.provider || null,
    model: probe.model || null,
    output: probe.output || null,
    attempts: probe.attempts || null,
    error: probe.error || null,
    configured: {
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      gemini1: Boolean(process.env.GEMINI_API_KEY),
      gemini2: Boolean(process.env.GEMINI_API_KEY_2),
      gemini3: Boolean(process.env.GEMINI_API_KEY_3),
    },
  });
}
