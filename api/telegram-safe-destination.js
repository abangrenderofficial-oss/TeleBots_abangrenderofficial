export default async function handler(req, res) {
  // EMERGENCY PAUSE: Telegram webhook processing is intentionally disabled
  // to stop accidental/duplicate mass sends to the destination group.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, paused: true });
}
