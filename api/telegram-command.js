import controlHandler from './telegram-control.js';
import { telegram, isAdminMessage } from '../lib/telegram.js';
import { getQueueItem, getSetting, setSetting } from '../lib/store.js';

const COMMAND_TEXT = [
  '📋 COMMAND ABANGRENDER.CO BOT',
  '',
  'GLOBAL CONTROL',
  '1. /stop — STOP semua aktiviti kerja bot: SEND, caption dan recaption. Queue kekal disimpan.',
  '2. /resume — Sambung semula semua aktiviti tergendala guna code, caption dan setting/tick paling latest.',
  '',
  'QUEUE & STATUS',
  '3. /pending — Tengok item yang masih pending/ready.',
  '4. /total — Jumlah live file/document dalam bot. Photo tak dikira sebagai file.',
  '5. /stats — Statistik queue: sent, pending, failed, skipped dan caption replaced.',
  '',
  'CAPTION & MEMORY',
  '6. /setcaption — Set caption/footer global secara exact.',
  '7. /memories — Tengok long-term memory bot.',
  '8. /remember <ayat> — Simpan memory baru.',
  '9. /forget <id> — Padam memory ikut ID.',
  '10. /clearchat — Clear history chat AI; long-term memory kekal.',
  '',
  'BOT & DEBUG',
  '11. /command — Paparkan semua command ini.',
  '12. /help — Panduan ringkas penggunaan bot.',
  '13. /start — Buka panduan ringkas bot.',
  '14. /version — Check build/version yang sedang live.',
  '15. /aitest — Test sambungan Gemini AI.',
  '16. /whoami — Paparkan Telegram User ID.',
  '',
  'GROUP',
  '17. /connect — Hantar dalam group target untuk jadikan group itu destination SEND.',
  '',
  'ADVANCED / OPTIONAL',
  '18. /stopsend — Pause SEND sahaja.',
  '19. /resumesend — Sambung SEND sahaja.',
  '20. /stopcaption — Pause caption/recaption sahaja.',
  '21. /resumecaption — Sambung caption/recaption sahaja.',
  '',
  'Untuk kegunaan biasa, cukup ingat /stop dan /resume.',
  'Nota: EDIT, SEND, SEND ALL, SEND AGAIN dan RECAPTION AGAIN ialah button workflow, bukan slash command.',
].join('\n');

export default async function handler(req, res) {
  if (req.method !== 'POST') return controlHandler(req, res);

  const message = req.body?.message;
  const query = req.body?.callback_query;

  if (
    message?.chat?.type === 'private'
    && isAdminMessage(message)
    && ['/command', '/commands'].includes(String(message.text || '').trim().toLowerCase())
  ) {
    await telegram('sendMessage', {
      chat_id: message.chat.id,
      text: COMMAND_TEXT,
      disable_web_page_preview: true,
    });
    return res.status(200).json({ ok: true, command_list: true });
  }

  // Reliability fix for previews created BEFORE LIVE GROUP SYNC existed.
  // Their old ✏️ button still contains edit:<itemId>, so when the owner taps it
  // we immediately force the destination message to match the CURRENT caption
  // stored in DB. This repairs stale group captions even when the DB caption had
  // already been corrected earlier (meaning before/after comparison sees no new
  // change and the newer safety layer would otherwise skip the sync).
  let forcedItem = null;
  let forcedChatId = null;
  if (query?.message && isAdminMessage({ from: query.from })) {
    const data = String(query.data || '');
    const [action, id] = data.split(':');
    if (id && (action === 'edit' || action === 'back')) {
      forcedItem = await getQueueItem(id).catch(() => null);
      forcedChatId = query.message.chat.id;
    }
  }

  const shadow = createShadowResponse();
  await controlHandler(req, shadow);

  if (forcedItem?.id && forcedChatId != null) {
    const latest = await getQueueItem(forcedItem.id).catch(() => forcedItem);
    if (isSentWithDestination(latest)) {
      await forceCurrentCaptionToGroup(latest, forcedChatId).catch(() => {});
    }
  }

  return res.status(shadow.statusCode || 200).json(shadow.body || { ok: true });
}

function isSentWithDestination(item) {
  return Boolean(
    item?.id
    && String(item.status || '').toUpperCase() === 'SENT'
    && item.destination_chat_id
    && item.destination_message_id
  );
}

async function forceCurrentCaptionToGroup(item, adminChatId) {
  try {
    await telegram('editMessageCaption', {
      chat_id: item.destination_chat_id,
      message_id: item.destination_message_id,
      caption: item.final_caption_html || '',
      parse_mode: 'HTML',
    });
    await setSetting(`sent_live_sync:${item.id}`, {
      ok: true,
      source: 'old_preview_edit_force_sync',
      destination_chat_id: String(item.destination_chat_id),
      destination_message_id: item.destination_message_id,
      synced_at: new Date().toISOString(),
    }).catch(() => {});
  } catch (error) {
    const text = String(error?.message || error);
    if (/message is not modified/i.test(text)) {
      await setSetting(`sent_live_sync:${item.id}`, {
        ok: true,
        source: 'old_preview_already_current',
        destination_chat_id: String(item.destination_chat_id),
        destination_message_id: item.destination_message_id,
        synced_at: new Date().toISOString(),
      }).catch(() => {});
      return;
    }

    await setSetting(`sent_live_sync:${item.id}`, {
      ok: false,
      source: 'old_preview_edit_force_sync',
      error: text.slice(0, 500),
      failed_at: new Date().toISOString(),
    }).catch(() => {});

    await telegram('sendMessage', {
      chat_id: adminChatId,
      text: `⚠️ LIVE GROUP SYNC gagal untuk item ni. ${text}`.slice(0, 1000),
    }).catch(() => {});
  }
}

function createShadowResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}
