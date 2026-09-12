export default async function handler(req, res) {
  // EMERGENCY PAUSE: SEND ALL / RESEND worker is disabled.
  // This endpoint intentionally accepts requests but performs no Telegram sends.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, paused: true, emergency_stop: true });
}
