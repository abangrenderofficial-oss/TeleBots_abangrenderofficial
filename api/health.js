import { extractTelegramPostLink, fetchPublicTelegramPreview } from '../lib/bot/features/telegram-link-import.js';

export default async function handler(req, res) {
  if (String(req.query?.telegram_probe || '') === '1') {
    const url = String(req.query?.url || 'https://t.me/free3dsky/29983');
    const parsed = extractTelegramPostLink(url);
    if (!parsed || parsed.kind !== 'public') {
      return res.status(400).json({ ok: false, error: 'public Telegram post link required' });
    }

    try {
      const preview = await fetchPublicTelegramPreview(parsed);
      return res.status(200).json({ ok: true, parsed, preview });
    } catch (error) {
      return res.status(200).json({
        ok: false,
        parsed,
        error: String(error?.message || error).slice(0, 500),
      });
    }
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
      || process.env.UPSTAGE_API_KEY
      || process.env.GEMINI_API_KEY
      || process.env.GEMINI_API_KEY_2
      || process.env.GEMINI_API_KEY_3
    ),
    setupSecretConfigured: Boolean(process.env.SETUP_SECRET),
    aiProvider: process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.UPSTAGE_API_KEY
      ? 'multi-provider'
      : (process.env.GEMINI_API_KEY ? 'gemini' : null),
    aiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    agentModel: process.env.GEMINI_AGENT_MODEL || 'gemini-2.5-flash-lite',
    agentArchitecture: 'dynamic-toolbox-v1',
    agentToolCount: 51,
    formatLearning: 'per-format-profile-v1',
    aiReplyStyle: 'kuala-lumpur-pasar-chat-bubbles',
  });
}
