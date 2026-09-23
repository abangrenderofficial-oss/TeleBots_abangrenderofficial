import { probeTranslationFailover } from '../lib/translation-failover.js';

export default async function handler(req, res) {
  if (req.query?.translation_probe === '1' && req.query?.probe_token === 'ar260924p7') {
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

  res.status(200).json({
    ok: true,
    service: 'telebots-abangrenderofficial',
    build: 'format-learning-v1-kl-chat',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    adminConfigured: Boolean(process.env.ADMIN_TELEGRAM_ID),
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    aiConfigured: Boolean(process.env.GEMINI_API_KEY),
    setupSecretConfigured: Boolean(process.env.SETUP_SECRET),
    aiProvider: process.env.GEMINI_API_KEY ? 'gemini' : null,
    aiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    agentModel: process.env.GEMINI_AGENT_MODEL || 'gemini-2.5-flash-lite',
    agentArchitecture: 'dynamic-toolbox-v1',
    agentToolCount: 51,
    formatLearning: 'per-format-profile-v1',
    aiReplyStyle: 'kuala-lumpur-pasar-chat-bubbles',
  });
}
