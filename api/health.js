export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'telebots-abangrenderofficial',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    adminConfigured: Boolean(process.env.ADMIN_TELEGRAM_ID),
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
  });
}
