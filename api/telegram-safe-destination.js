import QRCode from 'qrcode';
import { routeUpdate } from '../lib/bot/update-router.js';
import { rejectUnauthorizedTelegramWebhook } from '../lib/bot/core/telegram-webhook-auth.js';
import { runTelegramQrAuthorization } from '../lib/bot/features/telegram-account.js';

const BUILD_MARKER = 'manual-recaption-trigger-v1';

function liveQrShell() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>Telegram Live QR</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f19;color:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}.card{width:min(560px,100%);background:#141a27;border:1px solid #2a3347;border-radius:24px;padding:28px;text-align:center;box-shadow:0 20px 70px rgba(0,0,0,.35)}h1{font-size:25px;margin:0 0 8px}.sub{color:#aeb8cb;line-height:1.5;margin:0 0 22px}.qr{background:#fff;border-radius:18px;padding:16px;width:min(420px,100%);height:auto;display:none;margin:0 auto}.timer{font-variant-numeric:tabular-nums;font-weight:700;font-size:17px;margin:18px 0 6px}.hint{font-size:14px;line-height:1.5;color:#8f9ab0;margin:0}.ok{font-size:15px;color:#b9f6ca;margin-top:18px}.error{color:#ffb4b4;line-height:1.5}</style>
</head>
<body>
  <main class="card" id="card">
    <h1>Telegram Live QR</h1>
    <p class="sub">Keep this page open. On your phone: Telegram → Settings → Devices → Add Device / Link Desktop Device.</p>
    <img id="qr" class="qr" alt="Telegram login QR" />
    <div class="timer" id="timer">Connecting to Telegram…</div>
    <p class="hint" id="hint">A fresh QR will appear here. Scan it while this page stays open.</p>
    <p class="ok">After a successful scan, the bot will connect automatically.</p>
  </main>
  <script>
    (() => {
      let timer = null;
      window.__setQr = (src, seconds) => {
        const img = document.getElementById('qr');
        const timerEl = document.getElementById('timer');
        const hint = document.getElementById('hint');
        if (img) { img.src = src; img.style.display = 'block'; }
        if (hint) hint.textContent = 'Scan this QR now. It refreshes automatically without closing this page.';
        let left = Math.max(1, Number(seconds) || 30);
        if (timer) clearInterval(timer);
        const draw = () => { if (timerEl) timerEl.textContent = 'Fresh QR: ' + Math.max(0, left) + 's'; };
        draw();
        timer = setInterval(() => { left -= 1; draw(); }, 1000);
      };
      window.__connected = () => {
        if (timer) clearInterval(timer);
        const card = document.getElementById('card');
        if (card) card.innerHTML = '<h1>✅ Telegram Connected</h1><p class="sub">Session saved successfully. You can close this page and return to the bot.</p>';
      };
      window.__failed = (message) => {
        if (timer) clearInterval(timer);
        const card = document.getElementById('card');
        if (card) card.innerHTML = '<h1>Telegram Login Error</h1><p class="error"></p>';
        const error = card?.querySelector('.error');
        if (error) error.textContent = message;
      };
    })();
  </script>
`;
}

function secondsUntil(expires) {
  const now = Math.floor(Date.now() / 1000);
  const value = Number(expires || 0);
  if (!Number.isFinite(value) || value <= now) return 30;
  return Math.max(3, Math.min(35, value - now + 1));
}

function scriptCall(name, ...args) {
  const encoded = args.map((value) => JSON.stringify(value).replaceAll('<', '\\u003c')).join(',');
  return `<script>window.${name}?.(${encoded});</script>\n`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const qrKey = typeof req.query?.key === 'string' ? req.query.key : '';
  if (req.method === 'GET' && qrKey) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");

    const abortController = new AbortController();
    let heartbeat;

    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    res.write(liveQrShell());
    res.flushHeaders?.();
    heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write('<!-- keepalive -->\n');
    }, 10000);

    try {
      const result = await runTelegramQrAuthorization(qrKey, {
        abortSignal: abortController.signal,
        onQr: async ({ deep_link, expires }) => {
          if (res.writableEnded || res.destroyed) return;
          const dataUrl = await QRCode.toDataURL(deep_link, {
            type: 'image/png',
            width: 640,
            margin: 3,
            errorCorrectionLevel: 'M',
          });
          res.write(scriptCall('__setQr', dataUrl, secondsUntil(expires)));
        },
      });

      if (!res.writableEnded && !res.destroyed) {
        if (!result?.valid) {
          res.write(scriptCall('__failed', 'QR session expired. Close this page and run /tglogin again.'));
        } else if (result.connected) {
          res.write(scriptCall('__connected'));
        } else if (!result.aborted) {
          res.write(scriptCall('__failed', 'Telegram authorization stopped before it completed.'));
        }
      }
    } catch (error) {
      console.error('Telegram live QR error:', error);
      if (!res.writableEnded && !res.destroyed) {
        const message = String(error?.message || error || 'Unknown error').slice(0, 180);
        res.write(scriptCall('__failed', message));
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) res.end('</body></html>');
    }
    return;
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
