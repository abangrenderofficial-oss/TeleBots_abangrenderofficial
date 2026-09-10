import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import { buildCaption, generateTitle } from '../lib/caption.js';
import { agentAssistant } from '../lib/agent.js';
import { testGeminiConnection } from '../lib/assistant.js';
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
  saveExample,
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

  // Hidden/optional shortcuts. Normal use should be conversation-first.
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
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `Okay, aku ingat. Memory #${saved.id} disimpan.`,
    });
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

  // Footer setup remains special because Telegram formatting/hidden links arrive as entities.
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
    await setSetting('admin_state', null);
    return telegram('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: `<b>Footer disimpan.</b>\n\n${html}`,
    });
  }

  if (hasMedia(message)) return prepareMedia(message);

  if (text) return handleAgentText(chatId, text, state);
}

async function handleAgentText(chatId, text, state) {
  const focusedItemId = state?.mode === 'FOCUS_ITEM' && state?.item_id ? state.item_id : null;

  // Show typing immediately so the chat feels like an AI conversation.
  telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  const plan = await agentAssistant({ chatId, text, focusedItemId });
  const item = focusedItemId ? await getQueueItem(focusedItemId) : await getLatestQueueItem(chatId);

  if (plan.action === 'show_stats') {
    if (item) await keepFocus(item.id);
    return sendStats(chatId, plan.reply);
  }

  if (plan.action === 'show_pending') {
    if (plan.reply) await telegram('sendMessage', { chat_id: chatId, text: plan.reply });
    if (item) await keepFocus(item.id);
    return sendPending(chatId);
  }

  if (plan.action === 'remember') {
    if (!plan.memory) {
      if (item) await keepFocus(item.id);
      return telegram('sendMessage', {
        chat_id: chatId,
        text: plan.reply || 'Apa yang kau nak aku ingat?',
      });
    }

    const saved = await addMemory(chatId, plan.memory);
    if (item) await keepFocus(item.id);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: plan.reply || `Okay, aku ingat. Memory #${saved.id} disimpan.`,
    });
  }

  if (plan.action === 'skip_item') {
    if (!item) {
      return telegram('sendMessage', { chat_id: chatId, text: 'Tak ada item aktif untuk aku skip.' });
    }
    await updateQueueItem(item.id, { status: 'SKIPPED' });
    await setSetting('admin_state', null);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: plan.reply || 'Okay, item ni aku skip.',
    });
  }

  if (plan.action === 'preview_item') {
    if (!item) {
      return telegram('sendMessage', {
        chat_id: chatId,
        text: 'Tak ada item untuk preview sekarang. Hantar file, gambar atau video dulu.',
      });
    }
    await keepFocus(item.id);
    if (plan.reply) await telegram('sendMessage', { chat_id: chatId, text: plan.reply });
    return sendPreview(item.id, chatId);
  }

  if (plan.action === 'revise_item') {
    if (!item) {
      return telegram('sendMessage', {
        chat_id: chatId,
        text: 'Tak ada item aktif untuk aku ubah. Hantar file, gambar atau video dulu.',
      });
    }

    const newTitle = String(plan.title || '').trim();
    if (!newTitle) {
      await keepFocus(item.id);
      return telegram('sendMessage', {
        chat_id: chatId,
        text: plan.reply || 'Aku faham kau nak ubah item ni, tapi aku belum cukup jelas. Cakap je hasil yang kau nak.',
      });
    }

    const finalCaption = await buildCaption(newTitle);
    await updateQueueItem(item.id, {
      generated_title: newTitle,
      final_caption_html: finalCaption,
      status: 'READY',
      caption_replaced: true,
    });

    // Corrections teach the bot automatically in the background.
    if (plan.learnRule) {
      await saveExample(item.original_caption || item.file_name || '', newTitle);
      await saveLearnedPreference(plan.learnRule);
    }

    await keepFocus(item.id);

    await telegram('sendMessage', {
      chat_id: chatId,
      text: plan.reply || 'Okay, aku dah ubah ikut arahan kau. Preview baru ada di bawah.',
    });
    return sendPreview(item.id, chatId);
  }

  // Pure conversation. Keep the current item in context so follow-ups such as
  // "faham tak?" or "yang tadi" remain natural.
  if (item) await keepFocus(item.id);
  return telegram('sendMessage', {
    chat_id: chatId,
    text: plan.reply || 'Ya, aku dengar. Cakap je macam biasa.',
    disable_web_page_preview: true,
  });
}

async function keepFocus(itemId) {
  return setSetting('admin_state', { mode: 'FOCUS_ITEM', item_id: itemId });
}

async function saveLearnedPreference(rule) {
  const normalized = String(rule || '').trim();
  if (!normalized) return;

  const current = await getSetting('learned_title_rules');
  const rules = Array.isArray(current) ? current : [];
  if (rules.some((r) => String(r).toLowerCase() === normalized.toLowerCase())) return;

  await setSetting('learned_title_rules', [...rules, normalized].slice(-40));
}

async function prepareMedia(message) {
  const media = identifyMedia(message);
  let title;

  try {
    title = await generateTitle({ caption: message.caption || '', fileName: media.fileName || '' });
  } catch (error) {
    console.error('Title generation failed:', error);
    title = fallbackMediaTitle(message.caption || '', media.fileName || '');
  }

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
  return sendPreview(item.id, message.chat.id);
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

  // Backward compatibility for old preview buttons already visible in chat.
  if (data === 'pending') return sendPending(chatId);
  if (data === 'sendall') return sendAll(chatId);

  const [action, id] = data.split(':');
  if (!id) return;

  if (action === 'send') {
    await setSetting('admin_state', null);
    return sendItem(id, chatId);
  }

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
      text: 'Button lama tu dah tak perlu. Cakap terus macam biasa apa yang kau nak aku ubah atau belajar daripada item ni.',
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
    const before = item.status;
    await sendItem(item.id, chatId);
    const after = await getQueueItem(item.id);
    if (after?.status === 'SENT') sent += 1;
    else if (before !== 'SENT') failed += 1;
  }

  return telegram('sendMessage', {
    chat_id: chatId,
    text: `Send all selesai. Sent: ${sent}. Failed: ${failed}.`,
  });
}

async function sendStats(chatId, intro = '') {
  const s = await stats();
  const body = `Total file: ${s.total}\nSent: ${s.sent}\nPending: ${s.pending}\nFailed: ${s.failed}\nCaption replaced: ${s.caption_replaced}\n\nPhoto/image tak dikira dalam total file utama.`;
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `${intro ? `${intro}\n\n` : ''}${body}`,
  });
}

async function sendPending(chatId) {
  const items = await listPending(20);
  if (!items.length) return telegram('sendMessage', { chat_id: chatId, text: 'Tak ada item pending.' });

  const body = items.map((item, i) => {
    return `${i + 1}. ${item.file_name || item.generated_title || 'Untitled'} — ${item.status}`;
  }).join('\n');

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
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `Memory aku sekarang:\n\n${body}`,
  });
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
    text: 'Abang Render Coordinator\n\nAku AI assistant kau. Tak perlu hafal command atau tekan button untuk edit/ajar. Hantar file dan sembang terus macam biasa. Kalau kau nak ubah title/caption, ajar format, tanya jumlah file, semak pending atau tanya apa-apa — cakap je.\n\nBila hasil dah ready, aku tunjuk preview dengan satu button SEND. Itu saja button utama yang perlu.',
  });
}
