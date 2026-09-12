const CHAT_ID = '-1003005609440';
const START_ID = 14075;
const END_ID = 14458;
const CLEANUP_KEY = 'range_14075_14458_7f3c91a2d64e4b85b0a7';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telegram(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
  return data.result;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ ok: false, error: 'GET/POST only' });

  const suppliedKey = req.method === 'GET'
    ? String(req.query?.key || '')
    : String(req.headers['x-cleanup-key'] || req.body?.key || '');
  if (suppliedKey !== CLEANUP_KEY) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'missing bot token' });

  const ids = [];
  for (let id = START_ID; id <= END_ID; id += 1) ids.push(id);

  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  const failedIds = [];
  let bulkDeleted = 0;

  for (const chunk of chunks) {
    try {
      await telegram(token, 'deleteMessages', {
        chat_id: CHAT_ID,
        message_ids: chunk,
      });
      bulkDeleted += chunk.length;
    } catch (bulkError) {
      for (const messageId of chunk) {
        try {
          await telegram(token, 'deleteMessage', {
            chat_id: CHAT_ID,
            message_id: messageId,
          });
        } catch (error) {
          failedIds.push({ id: messageId, error: String(error?.message || error).slice(0, 180) });
        }
        await sleep(35);
      }
    }
    await sleep(120);
  }

  const attempted = ids.length;
  const failed = failedIds.length;
  const successfulOrAlreadyGone = attempted - failed;

  return res.status(200).json({
    ok: failed === 0,
    chat_id: CHAT_ID,
    start_id: START_ID,
    end_id: END_ID,
    attempted,
    successful_or_already_gone: successfulOrAlreadyGone,
    failed,
    failed_ids: failedIds,
  });
}
