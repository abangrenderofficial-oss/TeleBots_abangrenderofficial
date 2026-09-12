const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ITEM_ID = '811261bc-ee7a-4c59-b197-0e4e385db8a8';
const ADMIN_CHAT_ID = '6749355196';
const PREVIEW_MESSAGE_ID = 1533;
const DESTINATION_CHAT_ID = '-1003005609440';
const DESTINATION_MESSAGE_ID = 14068;

const CAPTION_HTML = `<b><i>Tutorial Download:</i></b>
<b>Telegram Web&gt;Download&gt;Right Click&gt;Show In Folder(Folder ada di situ)</b>

<b>More collection here | Abang R E N D E R </b>:
<a href="https://t.me/+x5-dhuGisHg2OGM1">3D MODEL</a> • <a href="https://t.me/+AQn2_bX7VcU3ODg1">PBR TEXTURE</a> • <a href="https://t.me/+sxD2CcHF-aYxNWI1">HDRI</a> • <a href="https://t.me/+axj-XukBiMQyNjM1">SOFTWARE</a> • <a href="https://t.me/+fTnLAGMKHe9jZjVl">VIDEO TUTORIAL</a> • <a href="https://t.me/+zvBDM9R-gqIzNWZl">GROUP DISCUSSION</a> •`;

if (!BOT_TOKEN || !SUPABASE_URL || !SERVICE_KEY) {
  console.error('One-time patch skipped: required production env is missing.');
  process.exit(1);
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) {
    const description = String(data.description || 'Telegram request failed');
    if (/message is not modified/i.test(description)) return { ok: true, alreadyCurrent: true };
    throw new Error(description);
  }
  return data;
}

async function patchDatabase() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/queue_items?id=eq.${ITEM_ID}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify({
      final_caption_html: CAPTION_HTML,
      generated_title: null,
      caption_replaced: true,
    }),
  });
  if (!response.ok) throw new Error(`Supabase patch failed (${response.status})`);
}

await patchDatabase();
await telegram('editMessageCaption', {
  chat_id: DESTINATION_CHAT_ID,
  message_id: DESTINATION_MESSAGE_ID,
  caption: CAPTION_HTML,
  parse_mode: 'HTML',
});
await telegram('editMessageCaption', {
  chat_id: ADMIN_CHAT_ID,
  message_id: PREVIEW_MESSAGE_ID,
  caption: CAPTION_HTML,
  parse_mode: 'HTML',
});

console.log(`One-time caption patch complete for destination message ${DESTINATION_MESSAGE_ID}.`);
