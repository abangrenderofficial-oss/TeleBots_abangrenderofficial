export default async function handler(req, res) {
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
