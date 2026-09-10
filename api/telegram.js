import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import { buildCaption, generateTitle } from '../lib/caption.js';
import { agentAssistant } from '../lib/agent.js';
import { testGeminiConnection } from '../lib/assistant.js';
import { duplicateNotice, inspectIncomingDuplicate } from '../lib/duplicates.js';
import { telegramTextToHtml } from '../lib/entities.js';
import {
  addMemory,
  clearChatHistory,
  createQueueItem,
  deleteMemory,
  getLatestQueueItem,
  getQueueItem,
  getSetting,
  listMemories,
  listPending,
  setSetting,
  stats,
  updateQueueItem,
} from '../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const update = req.body || {};
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    return res.status(200).json({ ok: true, handled: false });
  }
}

async function handleMessage(message) {
  if (message.chat?.type !== 'private') return;

  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (text === '/whoami') {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `Telegram User ID: ${message.from?.id ?? 'unknown'}`,
    });
  }

  if (!isAdminMessage(message)) return;

  if (text === '/start' || text === '/help') return sendHelp(chatId);

  // Debug/backup shortcuts remain available, but daily use is AI conversation.
  if (text === '/aitest') {
    await telegram('sendMessage', { chat_id: chatId, text: 'Aku test sambungan Gemini sekarang...' });
    const result = await testGeminiConnection();
    return telegram('sendMessage', { chat_id: chatId, text: formatAiTestResult(result) });
  }
  if (text === '/stats') return sendStats(chatId);
  if (text === '/pending') return sendPending(chatId);
  if (text === '/memories') return sendMemories(chatId);

  if (text?.startsWith('/remember ')) {
    const memory = text.slice('/remember '.length).trim();
    if (!memory) return;
    const saved = await addMemory(chatId, memory);
    return telegram('sendMessage', { chat_id: chatId, text: `Okay, aku ingat. Memory #${saved.id} disimpan.` });
  }

  if (text?.startsWith('/forget ')) {
    const id = Number(text.slice('/forget '.length).trim());
    if (!Number.isInteger(id) || id <= 0) {
      return telegram('sendMessage', { chat_id: chatId, text: 'Memory ID tak valid.' });
    }
    const deleted = await deleteMemory(chatId, id);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: deleted?.length ? `Memory #${id} dah dipadam.` : `Memory #${id} tak jumpa.`,
    });
  }

  if (text === '/clearchat') {
    await clearChatHistory(chatId);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Chat history AI dah dikosongkan. Long-term memory masih kekal.',
    });
  }

  // Exact rich-text footer setup remains as a backup because Telegram entities
  // carry hidden-link formatting that ordinary plain text cannot reconstruct.
  if (text === '/setcaption') {
    await setSetting('admin_state', { mode: 'SET_CAPTION' });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Hantar footer tepat macam yang kau nak. Hidden link, bold dan italic Telegram akan disimpan.',
    });
  }

  const state = await getSetting('admin_state');

  if (state?.mode === 'SET_CAPTION' && text) {
    const html = telegramTextToHtml(message.text, message.entities || []);
    await setSetting('caption_footer_html', html);
    const item = state?.item_id ? await getQueueItem(state.item_id) : await getLatestQueueItem(chatId);

    if (item) {
      const finalCaption = await buildCaption(item.generated_title || 'Untitled');
      await updateQueueItem(item.id, { final_caption_html: finalCaption, caption_replaced: true });
      await keepFocus(item.id);
      await telegram('sendMessage', { chat_id: chatId, text: 'Okay, footer dah disimpan dan aku apply pada item sekarang.' });
      return sendPreview(item.id, chatId);
    }

    await setSetting('admin_state', null);
    return telegram('sendMessage', { chat_id: chatId, text: 'Okay, footer dah disimpan.' });
  }

  if (hasMedia(message)) return prepareMedia(message);
  if (text) return handleAgentText(chatId, message, state);
}

async function handleAgentText(chatId, message, state) {
  const text = message.text?.trim() || '';
  const focusedItemId = state?.mode === 'FOCUS_ITEM' && state?.item_id ? state.item_id : null;

  telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  const result = await agentAssistant({
    chatId,
    text,
    focusedItemId,
    ownerText: message.text || text,
    ownerEntities: message.entities || [],
  });

  if (result.focusedItemId) await keepFocus(result.focusedItemId);

  if (result.reply) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: result.reply,
      disable_web_page_preview: true,
    });
  }

  for (const effect of result.effects || []) {
    if (effect.type === 'preview_item' && effect.item_id) {
      await keepFocus(effect.item_id);
      await sendPreview(effect.item_id, chatId);
    } else if (effect.type === 'confirm_send_all') {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: effect.count
          ? `Ada ${effect.count} item yang ready untuk dihantar. Confirm kalau nak SEND ALL.`
          : 'Tak ada item yang ready untuk dihantar.',
        reply_markup: effect.count
          ? inlineKeyboard([[{ text: `🚀 SEND ALL (${effect.count})`, callback_data: 'sendall' }]])
          : undefined,
      });
    }
  }
}

async function keepFocus(itemId) {
  return setSetting('admin_state', { mode: 'FOCUS_ITEM', item_id: itemId });
}

async function prepareMedia(message) {
  const media = identifyMedia(message);
  const duplicateInput = {
    adminChatId: message.chat.id,
    sourceChatId: message.chat.id,
    sourceMessageId: message.message_id,
    fileUniqueId: media.fileUniqueId || '',
    caption: message.caption || '',
    fileName: media.fileName || '',
  };

  // First pass is cheap and catches Telegram's exact file identity before any AI work.
  const beforeAi = await inspectIncomingDuplicate(duplicateInput);
  if (beforeAi.kind === 'webhook_replay') return;
  if (beforeAi.kind === 'exact_file') return handleExactDuplicate(message, beforeAi);

  let title;
  try {
    title = await generateTitle({ caption: message.caption || '', fileName: media.fileName || '' });
  } catch (error) {
    console.error('Title generation failed:', error);
    title = fallbackMediaTitle(message.caption || '', media.fileName || '');
  }

  // Second pass can also spot same serial/model or same normalized title.
  const duplicateResult = await inspectIncomingDuplicate({
    ...duplicateInput,
    generatedTitle: title,
  });
  if (duplicateResult.kind === 'webhook_replay') return;
  if (duplicateResult.kind === 'exact_file') return handleExactDuplicate(message, duplicateResult);

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

  await keepFocus(item.id);

  if (duplicateResult.kind === 'same_serial' || duplicateResult.kind === 'same_title') {
    const notice = duplicateNotice(duplicateResult);
    if (notice) {
      await telegram('sendMessage', {
        chat_id: message.chat.id,
        text: notice,
      });
    }
  }

  return sendPreview(item.id, message.chat.id);
}

async function handleExactDuplicate(message, duplicateResult) {
  const oldItem = duplicateResult.match;
  if (oldItem?.id) await keepFocus(oldItem.id).catch(() => {});

  let deleted = false;
  let deleteError = '';
  try {
    await telegram('deleteMessage', {
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
    deleted = true;
  } catch (error) {
    deleteError = error?.message || 'unknown error';
    console.error('Duplicate auto-delete failed:', deleteError);
  }

  const notice = duplicateNotice(duplicateResult);
  const resultText = deleted
    ? 'Copy baru yang kau tersalah hantar dah aku delete. Rekod/item asal aku kekalkan.'
    : 'Aku detect duplicate exact, tapi Telegram tak benarkan aku delete mesej baru tu. Item baru tak dimasukkan ke queue.';

  return telegram('sendMessage', {
    chat_id: message.chat.id,
    text: `${notice}\n\n${resultText}`.slice(0, 3900),
  });
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
      [{ text: '✅ SEND', callback_data: `send:${item.id}` }],
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

  if (data === 'noop') return;
  if (data === 'pending') return sendPending(chatId);
  if (data === 'sendall') return sendAll(chatId);

  const [action, id] = data.split(':');
  if (!id) return;

  if (action === 'send') {
    await setSetting('admin_state', null);
    return sendItem(id, chatId);
  }

  // Backward compatibility for old preview buttons already visible in chat.
  if (action === 'skip') {
    await updateQueueItem(id, { status: 'SKIPPED' });
    await setSetting('admin_state', null);
    return telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: inlineKeyboard([[{ text: 'SKIPPED', callback_data: 'noop' }]]),
    });
  }

  if (action === 'edit' || action === 'teach') {
    await keepFocus(id);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Button lama tu dah tak perlu. Cakap terus macam biasa apa yang kau nak aku buat pada item ni.',
    });
  }
}

async function sendItem(id, chatId) {
  const item = await getQueueItem(id);
  if (!item || item.status === 'SENT') return;

  const destination = (await getSetting('destination_chat_id')) || process.env.DESTINATION_CHAT_ID;
  if (!destination) {
    await keepFocus(id);
    return telegram('sendMessage', { chat_id: chatId, text: 'Destination belum configured lagi.' });
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

    await setSetting('admin_state', null);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `SENT\n${item.file_name || item.generated_title}`,
    });
  } catch (error) {
    await updateQueueItem(id, { status: 'FAILED', error_message: error.message });
    await keepFocus(id);
    return telegram('sendMessage', { chat_id: chatId, text: `FAILED\n${error.message}` });
  }
}

async function sendAll(chatId) {
  const items = await listPending(50);
  if (!items.length) return telegram('sendMessage', { chat_id: chatId, text: 'Tak ada item pending.' });

  let sent = 0;
  let failed = 0;
  for (const item of items) {
    if (!['READY', 'FAILED'].includes(item.status)) continue;
    await sendItem(item.id, chatId);
    const after = await getQueueItem(item.id);
    if (after?.status === 'SENT') sent += 1;
    else failed += 1;
  }

  return telegram('sendMessage', {
    chat_id: chatId,
    text: `Send all selesai. Sent: ${sent}. Failed: ${failed}.`,
  });
}

async function sendStats(chatId, intro = '') {
  const s = await stats();
  const body = `Total file: ${s.total}\nSent: ${s.sent}\nPending: ${s.pending}\nFailed: ${s.failed}\nSkipped: ${s.skipped || 0}\nCaption replaced: ${s.caption_replaced}\n\nPhoto/image tak dikira dalam total file utama.`;
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `${intro ? `${intro}\n\n` : ''}${body}`,
  });
}

async function sendPending(chatId) {
  const items = await listPending(20);
  if (!items.length) return telegram('sendMessage', { chat_id: chatId, text: 'Tak ada item pending.' });

  const body = items.map((item, i) => `${i + 1}. ${item.file_name || item.generated_title || 'Untitled'} — ${item.status}`).join('\n');
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `Pending sekarang (${items.length})\n\n${body}`.slice(0, 3900),
  });
}

async function sendMemories(chatId) {
  const memories = await listMemories(chatId, 30);
  if (!memories?.length) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Belum ada long-term memory. Cakap je macam “ingat lepas ni...” kalau kau nak aku simpan sesuatu.',
    });
  }

  const body = memories.map((m) => `#${m.id} — ${m.content}`).join('\n\n').slice(0, 3800);
  return telegram('sendMessage', { chat_id: chatId, text: `Memory aku sekarang:\n\n${body}` });
}

function formatAiTestResult(result) {
  if (result?.ok) {
    return `Gemini connection OK\nModel: ${result.model}\nResponse time: ${result.ms}ms\nReply: ${result.answer}`;
  }
  if (result?.error) return `Gemini test gagal\n${result.error}`;
  const attempts = (result?.attempts || []).map((x) => `• ${x.model}: ${x.error} (${x.ms}ms)`).join('\n');
  return `Gemini test gagal untuk semua model.\n\n${attempts || 'Tak ada detail.'}`.slice(0, 3900);
}

function fallbackMediaTitle(caption, fileName) {
  const lines = String(caption || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'))
    .filter((x) => !/^(?:tutorial download|more collection here)/i.test(x));

  if (lines.length) return lines.slice(0, 2).join('\n').slice(0, 180);
  if (fileName) return String(fileName).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 180);
  return 'Untitled';
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
    text: 'Abang Render Coordinator\n\nAku AI worker kau. Hantar file dan sembang terus macam biasa. Aku boleh cari item, edit title/caption, urus footer, belajar correction, semak duplicate, baca statistik, cari last send, ingat preference, skip, undo dan sediakan preview.\n\nDuplicate exact akan aku detect sebelum masuk queue dan copy baru akan aku delete automatik. Kalau cuma siri/title sama tapi file berbeza, aku warning saja dan tak delete.\n\nTak perlu button AJAR/EDIT atau format arahan khas. Bila nak publish, aku tunjuk preview dengan SEND untuk confirmation.',
  });
}
