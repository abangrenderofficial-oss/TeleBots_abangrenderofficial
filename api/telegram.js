import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import { buildCaption, generateTitle } from '../lib/caption.js';
import { chatAssistant } from '../lib/assistant.js';
import { telegramTextToHtml } from '../lib/entities.js';
import {
  addMemory,
  clearChatHistory,
  createQueueItem,
  deleteMemory,
  getQueueItem,
  getSetting,
  listMemories,
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

  if (text === '/memories') {
    return sendMemories(chatId);
  }

  if (text === '/remember') {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Guna macam ni:\n/remember Lepas ni title mesti dalam English.\n\nAtau cakap je “ingat lepas ni…” dan aku akan minta confirmation sebelum simpan.',
    });
  }

  if (text?.startsWith('/remember ')) {
    const memory = text.slice('/remember '.length).trim();
    if (!memory) return;
    const saved = await addMemory(chatId, memory);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `🧠 Memory saved #${saved.id}\n${saved.content}`,
    });
  }

  if (text === '/forget') {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Guna /memories untuk tengok nombor memory, kemudian /forget ID. Contoh: /forget 3',
    });
  }

  if (text?.startsWith('/forget ')) {
    const id = Number(text.slice('/forget '.length).trim());
    if (!Number.isInteger(id) || id <= 0) {
      return telegram('sendMessage', { chat_id: chatId, text: 'Memory ID tak valid. Contoh: /forget 3' });
    }
    const deleted = await deleteMemory(chatId, id);
    if (!deleted?.length) {
      return telegram('sendMessage', { chat_id: chatId, text: `Memory #${id} tak jumpa.` });
    }
    return telegram('sendMessage', { chat_id: chatId, text: `🗑 Memory #${id} dah dipadam.` });
  }

  if (text === '/clearchat') {
    await clearChatHistory(chatId);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '🧹 AI chat history dah dikosongkan. Long-term memory masih kekal. Guna /memories untuk tengok memory kekal.',
    });
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
    const memoryCandidate = extractMemoryRequest(text);
    if (memoryCandidate) {
      const key = pendingMemoryKey(chatId);
      await setSetting(key, { content: memoryCandidate });
      return telegram('sendMessage', {
        chat_id: chatId,
        text: `Kau nak aku simpan ini sebagai long-term memory?\n\n“${memoryCandidate}”`,
        reply_markup: inlineKeyboard([
          [
            { text: '✅ SIMPAN MEMORY', callback_data: 'memoryconfirm' },
            { text: '❌ BATAL', callback_data: 'memorycancel' },
          ],
        ]),
      });
    }

    const answer = await chatAssistant({ chatId, text });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: answer,
      disable_web_page_preview: true,
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

  if (data === 'memoryconfirm') {
    const key = pendingMemoryKey(chatId);
    const pending = await getSetting(key);
    if (!pending?.content) {
      return telegram('sendMessage', { chat_id: chatId, text: 'Tak ada pending memory untuk disimpan.' });
    }
    const saved = await addMemory(chatId, pending.content);
    await setSetting(key, null);
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: inlineKeyboard([[{ text: `🧠 SAVED #${saved.id}`, callback_data: 'noop' }]]),
    }).catch(() => {});
    return telegram('sendMessage', { chat_id: chatId, text: `✅ Aku akan ingat. Memory #${saved.id} disimpan.` });
  }

  if (data === 'memorycancel') {
    await setSetting(pendingMemoryKey(chatId), null);
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: inlineKeyboard([[{ text: '❌ MEMORY NOT SAVED', callback_data: 'noop' }]]),
    }).catch(() => {});
    return;
  }

  if (data === 'pending') return sendPending(chatId);
  if (data === 'sendall') return sendAll(chatId);
  if (data === 'noop') return;

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

async function sendMemories(chatId) {
  const memories = await listMemories(chatId, 30);
  if (!memories?.length) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '🧠 Belum ada long-term memory. Guna /remember <apa yang kau nak aku ingat> atau cakap “ingat lepas ni…”.',
    });
  }

  const body = memories.map((m) => `#${m.id} — ${m.content}`).join('\n\n').slice(0, 3800);
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `🧠 LONG-TERM MEMORY\n\n${body}\n\nPadam: /forget ID`,
  });
}

function extractMemoryRequest(text) {
  const value = String(text || '').trim();
  const patterns = [
    /^(?:ingat|remember)(?:\s+(?:yang|bahawa|that))?\s*[:,-]?\s+(.+)$/is,
    /^(?:simpan|save)\s+(?:ini\s+)?(?:dalam\s+)?(?:memory|memori|ingatan)\s*[:,-]?\s*(.+)$/is,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim().slice(0, 1500);
  }
  return null;
}

function pendingMemoryKey(chatId) {
  return `pending_ai_memory:${chatId}`;
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
    text: `<b>Abang Render Coordinator</b>\n\nAku sekarang juga AI chat assistant. Kau boleh chat biasa dan aku akan guna recent chat + long-term memory + keadaan queue untuk jawab.\n\n/setcaption — save permanent footer with clickable links\n/setrules — save title extraction & translation rules\n/stats — file totals (photos excluded)\n/pending — show unsent items\n/remember &lt;text&gt; — save long-term memory\n/memories — view saved memories\n/forget &lt;ID&gt; — delete a memory\n/clearchat — clear AI chat history only\n/help — show this menu`,
  });
}
