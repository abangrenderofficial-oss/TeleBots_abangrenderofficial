import QRCode from 'qrcode';
import { routeUpdate } from '../lib/bot/update-router.js';
import { rejectUnauthorizedTelegramWebhook } from '../lib/bot/core/telegram-webhook-auth.js';
import { getTelegramQrDisplay } from '../lib/bot/features/telegram-account.js';

const BUILD_MARKER = 'manual-recaption-trigger-v1';

function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function liveQrHtml({ dataUrl, expires }) {
  const now = Math.floor(Date.now() / 1000);
  const secondsLeft = Number.isFinite(Number(expires)) && Number(expires) > now
    ? Math.max(3, Math.min(35, Number(expires) - now + 1))
    : 20;

  const safeDataUrl = htmlEscape(dataUrl);
  const refreshMs = secondsLeft * 1000;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>Telegram Live QR</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f19;color:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}.card{width:min(560px,100%);background:#141a27;border:1px solid #2a3347;border-radius:24px;padding:28px;text-align:center;box-shadow:0 20px 70px rgba(0,0,0,.35)}h1{font-size:25px;margin:0 0 8px}.sub{color:#aeb8cb;line-height:1.5;margin:0 0 22px}.qr{background:#fff;border-radius:18px;padding:16px;width:min(420px,100%);height:auto;display:block;margin:0 auto}.timer{font-variant-numeric:tabular-nums;font-weight:700;font-size:17px;margin:18px 0 6px}.hint{font-size:14px;line-height:1.5;color:#8f9ab0;margin:0}.ok{font-size:15px;color:#b9f6ca;margin-top:18px}</style>
</head>
<body>
  <main class="card">
    <h1>Telegram Live QR</h1>
    <p class="sub">On your phone: Telegram → Settings → Devices → Add Device / Link Desktop Device, then scan this QR.</p>
    <img class="qr" src="${safeDataUrl}" alt="Telegram login QR" />
    <div class="timer">Fresh QR: <span id="count">${secondsLeft}</span>s</div>
    <p class="hint">Keep this page open. It will automatically request a new Telegram QR after the current token expires.</p>
    <p class="ok">After Telegram approves the device, return to the bot and type <b>check</b>.</p>
  </main>
  <script>
    (() => {
      let left = ${secondsLeft};
      const el = document.getElementById('count');
      const tick = setInterval(() => {
        left -= 1;
        if (el) el.textContent = Math.max(0, left);
        if (left <= 0) clearInterval(tick);
      }, 1000);
      setTimeout(() => location.reload(), ${refreshMs});
    })();
  </script>
</body>
</html>`;
}

function connectedHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Telegram Connected</title><style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f19;color:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}.card{max-width:520px;background:#141a27;border:1px solid #2a3347;border-radius:24px;padding:32px;text-align:center}h1{margin:0 0 10px}p{color:#b7c1d4;line-height:1.5}</style></head><body><main class="card"><h1>✅ Telegram Connected</h1><p>Authorization completed. You can close this page and return to the bot.</p></main></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const qrKey = typeof req.query?.key === 'string' ? req.query.key : '';
  if (req.method === 'GET' && qrKey) {
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");

    try {
      const display = await getTelegramQrDisplay(qrKey);
      if (!display) return res.status(404).send('QR session expired or unavailable');
      if (display.connected) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(connectedHtml());
      }
      if (!display.deep_link) return res.status(409).send('Unable to generate Telegram QR');

      const dataUrl = await QRCode.toDataURL(display.deep_link, {
        type: 'image/png',
        width: 640,
        margin: 3,
        errorCorrectionLevel: 'M',
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(liveQrHtml({ dataUrl, expires: display.expires }));
    } catch (error) {
      console.error('Telegram live QR error:', error);
      return res.status(500).send('Unable to generate Telegram QR');
    }
  }

  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      router: 'isolated-router-v1',
      build: BUILD_MARKER,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    });
  }

  if (rejectUnauthorizedTelegramWebhook(req, res)) return;

  try {
    return await routeUpdate(req, res);
  } catch (error) {
    console.error('Isolated Telegram router error:', error);
    return res.status(200).json({
      ok: true,
      handled: false,
      router: 'isolated-router-v1',
      build: BUILD_MARKER,
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      error: String(error?.message || error).slice(0, 500),
    });
  }
}
