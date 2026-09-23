import { probeTranslationFailover } from '../lib/translation-failover.js';
import { probeNamedProvider, probeProviderNames } from '../lib/provider-probe.js';

const PROBE_TOKEN = 'ar260924p7';

export default async function handler(req, res) {
  const authorizedProbe = req.query?.probe_token === PROBE_TOKEN;

  if (authorizedProbe && req.query?.translation_probe === '1') {
    const probe = await probeTranslationFailover();
    return res.status(probe.ok ? 200 : 503).json({
      ok: probe.ok,
      provider: probe.provider || null,
      model: probe.model || null,
      output: probe.output || null,
      attempts: probe.attempts || null,
      error: probe.error || null,
    });
  }

  if (authorizedProbe && req.query?.provider_probe === '1') {
    const provider = String(req.query?.provider || '').trim().toLowerCase();
    if (!provider) return res.status(200).json({ ok: true, providers: probeProviderNames() });
    const result = await probeNamedProvider(provider);
    return res.status(result.ok ? 200 : 503).json(result);
  }

  return res.status(200).json({
    ok: true,
    service: 'telebots-abangrenderofficial',
    build: 'format-learning-v1-kl-chat',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    adminConfigured: Boolean(process.env.ADMIN_TELEGRAM_ID),
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    aiConfigured: Boolean(
      process.env.GROQ_API_KEY
      || process.env.OPENROUTER_API_KEY
      || process.env.GEMINI_API_KEY
      || process.env.GEMINI_API_KEY_2
      || process.env.GEMINI_API_KEY_3
    ),
    setupSecretConfigured: Boolean(process.env.SETUP_SECRET),
    aiProvider: process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY ? 'multi-provider' : (process.env.GEMINI_API_KEY ? 'gemini' : null),
    aiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    agentModel: process.env.GEMINI_AGENT_MODEL || 'gemini-2.5-flash-lite',
    agentArchitecture: 'dynamic-toolbox-v1',
    agentToolCount: 51,
    formatLearning: 'per-format-profile-v1',
    aiReplyStyle: 'kuala-lumpur-pasar-chat-bubbles',
  });
}
