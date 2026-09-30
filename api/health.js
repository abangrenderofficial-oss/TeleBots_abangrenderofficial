async function rawTelegram(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

export default async function handler(req, res) {
  if (String(req.query?.telegram_copy_probe || '') === '29983') {
    try {
      const chatId = process.env.ADMIN_TELEGRAM_ID;
      if (!chatId) throw new Error('ADMIN_TELEGRAM_ID is not configured');
      const copied = await rawTelegram('copyMessage', {
        chat_id: chatId,
        from_chat_id: '@free3dsky',
        message_id: 29983,
        disable_notification: true,
      });
      const copiedMessageId = copied?.message_id || null;
      let deleted = false;
      if (copiedMessageId) {
        deleted = Boolean(await rawTelegram('deleteMessage', {
          chat_id: chatId,
          message_id: copiedMessageId,
        }).catch(() => false));
      }
      return res.status(200).json({ ok: true, mode: 'copyMessage-probe', copiedMessageId, deleted });
    } catch (error) {
      return res.status(200).json({ ok: false, mode: 'copyMessage-probe', error: String(error?.message || error).slice(0, 300) });
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
