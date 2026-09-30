import { extractTelegramPostLink, fetchPublicTelegramPreview } from '../lib/bot/features/telegram-link-import.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const url = String(req.query?.url || 'https://t.me/free3dsky/29983');
  const parsed = extractTelegramPostLink(url);
  if (!parsed || parsed.kind !== 'public') {
    return res.status(400).json({ ok: false, error: 'public Telegram post link required' });
  }

  try {
    const preview = await fetchPublicTelegramPreview(parsed);
    return res.status(200).json({
      ok: true,
      parsed,
      preview,
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      parsed,
      error: String(error?.message || error).slice(0, 500),
    });
  }
}
