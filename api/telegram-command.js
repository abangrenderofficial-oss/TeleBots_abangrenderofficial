import controlHandler from './telegram-control.js';
import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import { formatProfileKeyboardRows, getProfileForItem } from '../lib/format-profiles.js';
import { getFormatRemoveTerms, removeWordButtonLabel } from '../lib/remove-words.js';
import { getQueueItem, getSetting, setSetting, updateQueueItem } from '../lib/store.js';

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
  if (req.method === 'GET' && req.query?.manual_patch) {
    return runOneTimeManualPatch(req, res);
  }
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

  // Explicit manual sync is the final authority. This is intentionally simple:
  // take the caption currently stored on the queue item and patch the exact
  // destination message that was created when that item was SENT.
  if (query?.message && isAdminMessage({ from: query.from })) {
    const data = String(query.data || '');
    const [action, id] = data.split(':');
    if (action === 'update_group' && id) {
      return updateExactGroupMessage(query, res, id);
    }
  }

  let sentEditId = null;
  let sentEditChatId = null;
  if (query?.message && isAdminMessage({ from: query.from })) {
    const data = String(query.data || '');
    const [action, id] = data.split(':');
    if (action === 'edit' && id) {
      const item = await getQueueItem(id).catch(() => null);
      if (isSentWithDestination(item)) {
        sentEditId = id;
        sentEditChatId = query.message.chat.id;
      }
    }
  }

  const shadow = createShadowResponse();
  await controlHandler(req, shadow);

  // Old previews keep their old button payload forever, but pressing their
  // existing ✏️ still comes through here. Upgrade that edit menu on demand by
  // adding one explicit UPDATE GROUP button. No need to recreate old previews.
  if (sentEditId && sentEditChatId != null) {
    const latest = await getQueueItem(sentEditId).catch(() => null);
    if (isSentWithDestination(latest)) {
      await decorateSentEditWithUpdate(sentEditChatId, latest).catch(() => {});
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

async function runOneTimeManualPatch(req, res) {
  const token = String(req.query?.manual_patch || '').trim();
  if (!token || token.length < 24) {
    return res.status(404).json({ ok: false, error: 'manual_patch_not_found' });
  }

  const key = `manual_group_patch:${token}`;
  const task = await getSetting(key).catch(() => null);
  if (!task?.item_id) {
    return res.status(404).json({ ok: false, error: 'manual_patch_not_found' });
  }

  const item = await getQueueItem(task.item_id).catch(() => null);
  if (!isSentWithDestination(item)) {
    return res.status(409).json({ ok: false, error: 'sent_destination_missing' });
  }

  const caption = String(task.caption_html ?? item.final_caption_html ?? '');
  const updated = await updateQueueItem(item.id, {
    final_caption_html: caption,
    caption_replaced: true,
  }).catch(() => item);

  let groupUpdated = false;
  try {
    await telegram('editMessageCaption', {
      chat_id: item.destination_chat_id,
      message_id: item.destination_message_id,
      caption,
      parse_mode: 'HTML',
    });
    groupUpdated = true;
  } catch (error) {
    const text = String(error?.message || error);
    if (/message is not modified/i.test(text)) groupUpdated = true;
    else {
      await setSetting(`manual_group_patch_error:${item.id}`, {
        error: text.slice(0, 500),
        failed_at: new Date().toISOString(),
      }).catch(() => {});
      return res.status(502).json({ ok: false, error: 'group_update_failed', detail: text.slice(0, 300) });
    }
  }

  let previewUpdated = false;
  if (updated?.preview_message_id && updated?.admin_chat_id) {
    try {
      await telegram('editMessageCaption', {
        chat_id: updated.admin_chat_id,
        message_id: updated.preview_message_id,
        caption,
        parse_mode: 'HTML',
      });
      previewUpdated = true;
    } catch (error) {
      if (/message is not modified/i.test(String(error?.message || error))) previewUpdated = true;
    }
  }

  await Promise.all([
    setSetting(key, null),
    setSetting(`sent_live_sync:${item.id}`, {
      ok: true,
      source: 'one_time_manual_patch',
      destination_chat_id: String(item.destination_chat_id),
      destination_message_id: item.destination_message_id,
      synced_at: new Date().toISOString(),
    }),
  ]).catch(() => {});

  return res.status(200).json({
    ok: true,
    item_id: item.id,
    destination_message_id: item.destination_message_id,
    group_updated: groupUpdated,
    preview_updated: previewUpdated,
  });
}

async function updateExactGroupMessage(query, res, itemId) {
  const adminChatId = query.message.chat.id;
  const item = await getQueueItem(itemId).catch(() => null);

  if (!isSentWithDestination(item)) {
    await telegram('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Item ni tak ada destination SENT yang boleh di-update.',
      show_alert: true,
    }).catch(() => {});
    return res.status(200).json({ ok: true, updated_group: false });
  }

  try {
    await telegram('editMessageCaption', {
      chat_id: item.destination_chat_id,
      message_id: item.destination_message_id,
      caption: item.final_caption_html || '',
      parse_mode: 'HTML',
    });

    await setSetting(`sent_live_sync:${item.id}`, {
      ok: true,
      source: 'explicit_update_group_button',
      destination_chat_id: String(item.destination_chat_id),
      destination_message_id: item.destination_message_id,
      synced_at: new Date().toISOString(),
    }).catch(() => {});

    await telegram('answerCallbackQuery', {
      callback_query_id: query.id,
      text: '✅ Group caption updated.',
    }).catch(() => {});

    return res.status(200).json({ ok: true, updated_group: true, item_id: item.id });
  } catch (error) {
    const text = String(error?.message || error);

    if (/message is not modified/i.test(text)) {
      await setSetting(`sent_live_sync:${item.id}`, {
        ok: true,
        source: 'explicit_update_group_already_current',
        destination_chat_id: String(item.destination_chat_id),
        destination_message_id: item.destination_message_id,
        synced_at: new Date().toISOString(),
      }).catch(() => {});

      await telegram('answerCallbackQuery', {
        callback_query_id: query.id,
        text: '✅ Group memang dah guna caption latest.',
      }).catch(() => {});
      return res.status(200).json({ ok: true, updated_group: true, already_current: true });
    }

    await setSetting(`sent_live_sync:${item.id}`, {
      ok: false,
      source: 'explicit_update_group_button',
      error: text.slice(0, 500),
      failed_at: new Date().toISOString(),
    }).catch(() => {});

    await telegram('answerCallbackQuery', {
      callback_query_id: query.id,
      text: text.slice(0, 180),
      show_alert: true,
    }).catch(() => {});

    await telegram('sendMessage', {
      chat_id: adminChatId,
      text: `⚠️ UPDATE GROUP gagal untuk item ni. ${text}`.slice(0, 1000),
    }).catch(() => {});

    return res.status(200).json({ ok: true, updated_group: false, error: text });
  }
}

async function decorateSentEditWithUpdate(chatId, item) {
  if (!item?.preview_message_id) return;
  const profile = await getProfileForItem(item).catch(() => null);
  if (!profile) return;

  const removeTerms = await getFormatRemoveTerms(profile.id).catch(() => []);
  const rows = formatProfileKeyboardRows(profile, item.id);

  if (rows.length) rows.shift();
  if (rows.length) rows.pop();
  rows.unshift([{ text: '✅ SENT · EDIT MODE', callback_data: 'noop' }]);
  rows.push([{ text: removeWordButtonLabel(removeTerms), callback_data: `fmt_removeword:${item.id}` }]);
  rows.push([{ text: '🔄 UPDATE GROUP', callback_data: `update_group:${item.id}` }]);
  rows.push([{ text: '⬅️ BACK', callback_data: `back:${item.id}` }]);

  await telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: item.preview_message_id,
    reply_markup: inlineKeyboard(rows),
  });
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