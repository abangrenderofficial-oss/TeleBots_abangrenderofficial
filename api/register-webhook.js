import { telegram } from '../lib/telegram.js';

function normalizeSecret(value) {
  if (typeof value !== 'string') return '';
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function setupPage(message = '') {
  const status = message ? `<p style="margin-top:16px;white-space:pre-wrap">${message}</p>` : '';
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Telegram Webhook Setup</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:60px auto;padding:0 20px">
  <h2>Telegram Webhook Setup</h2>
  <p>Masukkan SETUP_SECRET yang sama seperti dalam Vercel.</p>
  <form id="f">
    <input id="secret" type="password" autocomplete="off" style="width:100%;box-sizing:border-box;padding:12px" placeholder="SETUP_SECRET" required>
    <button style="margin-top:12px;padding:10px 16px" type="submit">Register Webhook</button>
  </form>
  <pre id="out" style="margin-top:18px;white-space:pre-wrap"></pre>
  ${status}
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = document.getElementById('out');
      out.textContent = 'Registering...';
      const secret = document.getElementById('secret').value;
      const r = await fetch(location.pathname, {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({secret})
      });
      const data = await r.json().catch(() => ({ok:false,error:'Invalid response'}));
      out.textContent = JSON.stringify(data, null, 2);
    });
  </script>
</body></html>`;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET' && !req.query?.key) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(200).send(setupPage());
    }

    const expected = normalizeSecret(process.env.SETUP_SECRET || '');
    const supplied = normalizeSecret(
      req.method === 'POST'
        ? (req.body?.secret || req.headers['x-setup-secret'] || '')
        : (req.query?.key || '')
    );

    if (!expected || supplied !== expected) {
      return res.status(401).json({
        ok: false,
        error: 'Unauthorized',
        setupSecretConfigured: Boolean(expected),
        suppliedLength: supplied.length,
        expectedLength: expected.length
      });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const url = `${proto}://${host}/api/telegram`;

    const result = await telegram('setWebhook', {
      url,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });

    return res.status(200).json({ ok: true, webhook: url, result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
