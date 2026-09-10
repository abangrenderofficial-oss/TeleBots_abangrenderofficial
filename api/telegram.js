import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import { buildCaption, generateTitle } from '../lib/caption.js';
import { telegramTextToHtml } from '../lib/entities.js';
import {
  createQueueItem,
  getQueueItem,
  getSetting,
  listPending,
  saveExample,
  setSetting,
  stats,
  updateQueueItem,
} from '../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  res.status(200).json({ ok: true });

  try {
    const update = req.body || {};
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (error) {
    console.error(error);
  }
}

async function handleMessage(message) {
  if (!isAdminMessage(message) || message.chat?.type !== 'private') return;

  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (text === '/start' || text === '/help') {
    return sendHelp(chatId);
  }

  if (text === '/stats') {
    const s = await stats();
    return telegram('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: `<b>Abang Render Bot Statistics</b>\n\n📦 Total files received: <b>${s.total}</b>\n✏️ Captions replaced: <b>${s.caption_replaced}</b>\n✅ Files sent: <b>${s.sent}</b>\n⏳ Files pending: <b>${s.pending}</b>\n❌ Failed: <b>${s.failed}</b>\n\n<i>Photos are tracked in the queue but excluded from file totals.</i>`,
    });
  }

  if (text === '/pending') {
    return sendPending(chatId);
  }

  if (text === '/setcaption') {
    await setSetting('admin_state', { mode: 'SET_CAPTION' });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Send the footer exactly as you want it. Telegram hidden links, bold and italic formatting will be saved.',
    });
  }

  if (text === '/setrules') {
    await setSetting('admin_state', { mode: 'SET_RULES' });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Send your title rules in normal language. I will save them as the permanent title instructions.',
    });
  }

  const state = await getSetting('admin_state');
  if (state?.mode === 'SET_CAPTION' && text) {
    const html = telegramTextToHtml(message.text, message.entities || []);
    await setSetting('caption_footer_html', html);
    await setSetting('admin_state', null);
    return telegram('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: `<b>Caption footer saved.</b>\n\n${html}`,
    });
  }

  if (state?.mode === 'SET_RULES' && text) {
    await setSetting('title_rules', text);
    await setSetting('admin_state', null);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '✅ Title rules saved.',
    });
  }

  if (state?.mode === 'EDIT_TITLE' && text && state.item_id) {
    const item = await getQueueItem(state.item_id);
    if (!item) return;
    const finalCaption = await buildCaption(text);
    await updateQueueItem(item.id, {
      generated_title: text,
      final_caption_html: finalCaption,
      status: 'READY',
      caption_replaced: true,
    });
    await setSetting('admin_state', null);
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '✅ Title updated. Open /pending or use the latest preview to send it.',
    });
    return sendPreview(item.id, chatId);
  }

  if (state?.mode === 'TEACH_TITLE' && text && state.item_id) {
    const item = await getQueueItem(state.item_id);
    if (!item) return;
    await saveExample(item.original_caption || item.file_name || '', text);
    const finalCaption = await buildCaption(text);
    await updateQueueItem(item.id, {
      generated_title: text,
      final_caption_html: finalCaption,
      status: 'READY',
      caption_replaced: true,
    });
    await setSetting('admin_state', null);
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '🧠 Correction saved as a teaching example and this item was updated.',
    });
    return sendPreview(item.id, chatId);
  }

  if (hasMedia(message)) return prepareMedia(message);

  if (text) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'I am ready. Send me a file/photo with or without caption, or use /help.',
    });
  }
}

async function prepareMedia(message) {
  const media = identifyMedia(message);
  const title = await generateTitle({ caption: message.caption || '', fileName: media.fileName || '' });
  const finalCaption = await buildCaption(title);

  const item = await createQueueItem({
    admin_chat_id: message.chat.id,
    source_chat_id: message.chat.id,
    source_message_id: message.message_id,
    media_kind: media.kind,
    file_name: media.fileName || null,
    file_unique_id: media.fileUniqueId || null,
    original_caption: message.caption || null,
    generated_title: title,
    final_caption_html: finalCaption,
    status: 'READY',
    caption_replaced: true,
  });

  await sendPreview(item.id, message.chat.id);
}

async function sendPreview(itemId, chatId) {
  const item = await getQueueItem(itemId);
  if (!item) return;

  const copied = await telegram('copyMessage', {
    chat_id: chatId,
    from_chat_id: item.source_chat_id,
    message_id: item.source_message_id,
    caption: item.final_caption_html,
    parse_mode: 'HTML',
    disable_notification: true,
    reply_markup: inlineKeyboard([
      [
        { text: '✅ SEND', callback_data: `send:${item.id}` },
        { text: '✏️ EDIT TITLE', callback_data: `edit:${item.id}` },
      ],
      [
        { text: '🧠 TEACH THIS', callback_data: `teach:${item.id}` },
        { text: '⏭ SKIP', callback_data: `skip:${item.id}` },
      ],
      [
        { text: '🚀 SEND ALL', callback_data: 'sendall' },
        { text: '📋 PENDING', callback_data: 'pending' },
      ],
    ]),
  });

  await updateQueueItem(item.id, { preview_message_id: copied.message_id });
}

async function handleCallback(query) {
  const message = query.message;
  if (!message || !isAdminMessage({ from: query.from })) return;

  const chatId = message.chat.id;
  const data = query.data || '';
  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  if (data === 'pending') return sendPending(chatId);
  if (data === 'sendall') return sendAll(chatId);

  const [action, id] = data.split(':');
  if (!id) return;

  if (action === 'send') return sendItem(id, chatId);
  if (action === 'skip') {
    await updateQueueItem(id, { status: 'SKIPPED' });
    return telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: message.message_id, reply_markup: inlineKeyboard([[{ text: '⏭ SKIPPED', callback_data: 'noop' }]]) });
  }
  if (action === 'edit') {
    await setSetting('admin_state', { mode: 'EDIT_TITLE', item_id: id });
    return telegram('sendMessage', { chat_id: chatId, text: 'Send the corrected title for this item.' });
  }
  if (action === 'teach') {
    await setSetting('admin_state', { mode: 'TEACH_TITLE', item_id: id });
    return telegram('sendMessage', { chat_id: chatId, text: 'Teach me the correct title. Send only the title you want.' });
  }
}

async function sendItem(id, chatId) {
  const item = await getQueueItem(id);
  if (!item || item.status === 'SENT') return;

  const destination = (await getSetting('destination_chat_id')) || process.env.DESTINATION_CHAT_ID;
  if (!destination) {
    return telegram('sendMessage', { chat_id: chatId, text: '⚠️ Destination is not configured yet.' });
  }

  try {
    const sent = await telegram('copyMessage', {
      chat_id: destination,
      from_chat_id: item.source_chat_id,
      message_id: item.source_message_id,
      caption: item.final_caption_html,
      parse_mode: 'HTML',
    });
    await updateQueueItem(id, {
      status: 'SENT',
      destination_chat_id: String(destination),
      destination_message_id: sent.message_id,
      sent_at: new Date().toISOString(),
      error_message: null,
    });
    await telegram('sendMessage', { chat_id: chatId, text: `✅ SENT\n${item.file_name || item.generated_title}` });
  } catch (error) {
    await updateQueueItem(id, { status: 'FAILED', error_message: error.message });
    await telegram('sendMessage', { chat_id: chatId, text: `🔴 FAILED\n${error.message}` });
  }
}

async function sendAll(chatId) {
  const items = await listPending(50);
  if (!items.length) return telegram('sendMessage', { chat_id: chatId, text: 'No pending items.' });

  let sent = 0;
  let failed = 0;
  for (const item of items) {
    if (!['READY', 'FAILED'].includes(item.status)) continue;
    try {
      await sendItem(item.id, chatId);
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return telegram('sendMessage', { chat_id: chatId, text: `🚀 Send All finished.\n✅ Attempted/sent: ${sent}\n❌ Failed: ${failed}` });
}

async function sendPending(chatId) {
  const items = await listPending(20);
  if (!items.length) return telegram('sendMessage', { chat_id: chatId, text: '✅ No pending items.' });

  const body = items.map((item, i) => {
    const icon = item.status === 'FAILED' ? '🔴' : '🟡';
    const type = item.media_kind === 'document' ? '📦' : '🖼';
    return `${i + 1}. ${icon} ${type} ${item.file_name || item.generated_title || 'Untitled'} — ${item.status}`;
  }).join('\n');

  return telegram('sendMessage', {
    chat_id: chatId,
    text: `⏳ PENDING QUEUE (${items.length})\n\n${body}`,
    reply_markup: inlineKeyboard([[{ text: '🚀 SEND ALL', callback_data: 'sendall' }]]),
  });
}

function hasMedia(message) {
  return Boolean(message.document || message.photo || message.video || message.animation || message.audio);
}

function identifyMedia(message) {
  if (message.document) return { kind: 'document', fileName: message.document.file_name, fileUniqueId: message.document.file_unique_id };
  if (message.photo) {
    const p = message.photo.at(-1);
    return { kind: 'photo', fileUniqueId: p?.file_unique_id };
  }
  if (message.video) return { kind: 'video', fileName: message.video.file_name, fileUniqueId: message.video.file_unique_id };
  if (message.animation) return { kind: 'animation', fileName: message.animation.file_name, fileUniqueId: message.animation.file_unique_id };
  if (message.audio) return { kind: 'audio', fileName: message.audio.file_name, fileUniqueId: message.audio.file_unique_id };
  return { kind: 'other' };
}

async function sendHelp(chatId) {
  return telegram('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: `<b>Abang Render Coordinator</b>\n\nSend a file/photo and I will prepare a caption preview.\n\n/setcaption — teach/save the permanent footer with clickable links\n/setrules — teach title extraction & translation rules\n/stats — file totals (photos excluded)\n/pending — show unsent items\n/help — show this menu`,
  });
}
