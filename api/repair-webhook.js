import { getSetting, setSetting } from '../lib/store.js';

const SAFE_WEBHOOK_URL = 'https://tele-bots-abangrenderofficial.vercel.app/api/telegram';
const CLEANUP_SETTING = 'emergency_cleanup_14075_14458_done';
const CLEANUP_CHAT_ID = '-1003005609440';
const CLEANUP_START = 14075;
const CLEANUP_END = 14458;

async function telegram(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function runOneTimeCleanup(token) {
  const done = await getSetting(CLEANUP_SETTING).catch(() => null);
  if (done?.completed) return done;

  const ids = [];
  for (let id = CLEANUP_START; id <= CLEANUP_END; id += 1) ids.push(id);

  const failed = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      await telegram(token, 'deleteMessages', {
        chat_id: CLEANUP_CHAT_ID,
        message_ids: chunk,
      });
    } catch (bulkError) {
      for (const messageId of chunk) {
        try {
          await telegram(token, 'deleteMessage', {
            chat_id: CLEANUP_CHAT_ID,
            message_id: messageId,
          });
        } catch (error) {
          failed.push({ id: messageId, error: String(error?.message || error).slice(0, 180) });
        }
      }
    }
  }

  const result = {
    completed: failed.length === 0,
    chat_id: CLEANUP_CHAT_ID,
    start_id: CLEANUP_START,
    end_id: CLEANUP_END,
    attempted: ids.length,
    failed_count: failed.length,
    failed,
    completed_at: new Date().toISOString(),
  };
  await setSetting(CLEANUP_SETTING, result).catch(() => {});
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'missing_token' });

  try {
    const cleanup = await runOneTimeCleanup(token);

    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: SAFE_WEBHOOK_URL,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: false,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram setWebhook failed');

    return res.status(cleanup.completed ? 200 : 500).json({
      ok: cleanup.completed,
      url: SAFE_WEBHOOK_URL,
      cleanup,
    });
  } catch (error) {
    console.error('Webhook repair/cleanup failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'Webhook repair/cleanup failed' });
  }
}
