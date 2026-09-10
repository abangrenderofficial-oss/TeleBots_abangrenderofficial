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

  if (text === '/aitest') {
    await telegram('sendMessage', { chat_id: chatId, text: '🔌 Aku test sambungan Gemini sekarang...' });
    const result = await testGeminiConnection();
    return telegram('sendMessage', { chat_id: chatId, text: formatAiTestResult(result) });
  }

  // Commands stay available as shortcuts, but normal chat does not depend on them.
  if (text === '/stats') return sendStats(chatId);
  if (text === '/pending') return sendPending(chatId);
  if (text === '/memories') return sendMemories(chatId);

  if (text === '/remember') {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Kau tak wajib guna command. Cakap je macam “ingat lepas ni title bahasa asing translate English”. Aku akan simpan terus bila arahan tu jelas.',
    });
  }

  if (text?.startsWith('/remember ')) {
    const memory = text.slice('/remember '.length).trim();
    if (!memory) return;
    const saved = await addMemory(chatId, memory);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `🧠 Okay, aku ingat. Memory #${saved.id} disimpan.`,
    });
  }

  if (text === '/forget') {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Guna /memories untuk tengok ID memory, kemudian /forget ID. Contoh: /forget 3',
    });
  }

  if (text?.startsWith('/forget ')) {
    const id = Number(text.slice('/forget '.length).trim());
    if (!Number.isInteger(id) || id <= 0) {
      return telegram('sendMessage', { chat_id: chatId, text: 'Memory ID tak valid. Contoh: /forget 3' });
    }
    const deleted = await deleteMemory(chatId, id);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: deleted?.length ? `🗑 Memory #${id} dah dipadam.` : `Memory #${id} tak jumpa.`,
    });
  }

  if (text === '/clearchat') {
    await clearChatHistory(chatId);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '🧹 Chat history AI dah dikosongkan. Long-term memory masih kekal.',
    });
  }

  if (text === '/setcaption') {
    await setSetting('admin_state', { mode: 'SET_CAPTION' });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Send footer tepat macam yang kau nak. Hidden link, bold dan italic Telegram akan disimpan.',
    });
  }

  if (text === '/setrules') {
    await setSetting('admin_state', { mode: 'SET_RULES' });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Terangkan arahan asas title yang kau nak. Lepas ni AI masih boleh belajar correction baru daripada chat biasa.',
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
      text: `<b>✅ Footer disimpan.</b>\n\n${html}`,
    });
  }

  if (state?.mode === 'SET_RULES' && text) {
    await setSetting('title_rules', text);
    await setSetting('admin_state', null);
    return telegram('sendMessage', { chat_id: chatId, text: '✅ Arahan asas title dah disimpan.' });
  }

  if (hasMedia(message)) return prepareMedia(message);

  if (text) return handleAgentText(chatId, text, state);
}

async function handleAgentText(chatId, text, state) {
  const focusedItemId = state?.item_id || null;
  const focusMode = state?.mode === 'FOCUS_TEACH' ? 'TEACH' : state?.mode === 'FOCUS_EDIT' ? 'EDIT' : null;

  const plan = await agentAssistant({
    chatId,
    text,
    focusedItemId,
    focusMode,
  });

  if (plan.action === 'show_stats') {
    await setSetting('admin_state', null);
    return sendStats(chatId, plan.reply);
  }

  if (plan.action === 'show_pending') {
    await setSetting('admin_state', null);
    if (plan.reply) await telegram('sendMessage', { chat_id: chatId, text: plan.reply });
    return sendPending(chatId);
  }

  if (plan.action === 'remember') {
    await setSetting('admin_state', null);
    if (!plan.memory) {
      return telegram('sendMessage', { chat_id: chatId, text: plan.reply || 'Apa yang kau nak aku ingat?' });
    }
    const saved = await addMemory(chatId, plan.memory);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: plan.reply || `🧠 Okay, aku ingat. Memory #${saved.id} disimpan.`,
    });
  }

  if (plan.action === 'preview_item') {
    const item = focusedItemId ? await getQueueItem(focusedItemId) : await getLatestQueueItem(chatId);
    await setSetting('admin_state', null);
    if (!item) {
      return telegram('sendMessage', { chat_id: chatId, text: 'Tak ada item untuk aku preview sekarang. Hantar file/gambar/video dulu.' });
    }
    if (plan.reply) await telegram('sendMessage', { chat_id: chatId, text: plan.reply });
    return sendPreview(item.id, chatId);
  }

  if (plan.action === 'revise_item') {
    const item = focusedItemId ? await getQueueItem(focusedItemId) : await getLatestQueueItem(chatId);
    if (!item) {
      await setSetting('admin_state', null);
      return telegram('sendMessage', { chat_id: chatId, text: 'Tak ada item aktif untuk aku ubah. Hantar file/gambar/video dulu.' });
    }

    const newTitle = String(plan.title || '').trim();
    if (!newTitle) {
      return telegram('sendMessage', {
        chat_id: chatId,
        text: plan.reply || 'Aku faham kau nak ubah item ni, tapi aku belum dapat title akhir yang jelas. Cakap je hasil yang kau nak.',
      });
    }

    const finalCaption = await buildCaption(newTitle);
    await updateQueueItem(item.id, {
      generated_title: newTitle,
      final_caption_html: finalCaption,
      status: 'READY',
      caption_replaced: true,
    });

    // Natural corrections become learning automatically instead of requiring a rigid confirmation flow.
    if (focusMode === 'TEACH' || plan.learnRule) {
      await saveExample(item.original_caption || item.file_name || '', newTitle);
    }
    if (plan.learnRule) await saveLearnedRule(plan.learnRule);

    await setSetting('admin_state', null);

    await telegram('sendMessage', {
      chat_id: chatId,
      text: plan.reply || 'Okay, aku dah ubah ikut arahan kau. Aku tunjuk preview baru di bawah.',
    });
    return sendPreview(item.id, chatId);
  }

  // Normal conversation is always allowed. No rule gate blocks it.
  await setSetting('admin_state', null);
  return telegram('sendMessage', {
    chat_id: chatId,
    text: plan.reply || 'Aku dengar. Cakap je apa kau nak aku bantu.',
    disable_web_page_preview: true,
  });
}

async function saveLearnedRule(rule) {
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

  await setSetting('admin_state', { mode: 'FOCUS_ITEM', item_id: item.id });
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
      [
        { text: '✅ SEND', callback_data: `send:${item.id}` },
        { text: '✏️ EDIT', callback_data: `edit:${item.id}` },
      ],
      [
        { text: '🧠 AJAR AI', callback_data: `teach:${item.id}` },
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
  if (data === 'noop') return;

  const [action, id] = data.split(':');
  if (!id) return;

  if (action === 'send') {
    await setSetting('admin_state', null);
    return sendItem(id, chatId);
  }

  if (action === 'skip') {
    await setSetting('admin_state', null);
    await updateQueueItem(id, { status: 'SKIPPED' });
    return telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: inlineKeyboard([[{ text: '⏭ SKIPPED', callback_data: 'noop' }]]),
    });
  }

  if (action === 'edit') {
    await setSetting('admin_state', { mode: 'FOCUS_EDIT', item_id: id });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Cakap je macam biasa apa yang kau nak ubah pada item ni. Tak perlu bagi title dalam format tertentu.',
    });
  }

  if (action === 'teach') {
    await setSetting('admin_state', { mode: 'FOCUS_TEACH', item_id: id });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Ajar aku macam sembang biasa. Contoh: “yang ni buang hashtag, kekalkan no siri + nama model”. Aku akan ubah preview dan belajar untuk item seterusnya.',
    });
  }
}

async function sendItem(id, chatId) {
  const item = await getQueueItem(id);
  if (!item || item.status === 'SENT') return;

  const destination = (await getSetting('destination_chat_id')) || process.env.DESTINATION_CHAT_ID;
  if (!destination) {
    return telegram('sendMessage', { chat_id: chatId, text: '⚠️ Destination belum configured.' });
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

    return telegram('sendMessage', {
      chat_id: chatId,
      text: `✅ SENT\n${item.file_name || item.generated_title}`,
    });
  } catch (error) {
    await updateQueueItem(id, { status: 'FAILED', error_message: error.message });
    return telegram('sendMessage', { chat_id: chatId, text: `🔴 FAILED\n${error.message}` });
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
    text: `🚀 Send All selesai.\n✅ Sent: ${sent}\n❌ Failed: ${failed}`,
  });
}

async function sendStats(chatId, intro = '') {
  const s = await stats();
  const text = `${intro ? `${intro}\n\n` : ''}📦 Total file: ${s.total}\n✅ Sent: ${s.sent}\n⏳ Pending: ${s.pending}\n❌ Failed: ${s.failed}\n✏️ Caption replaced: ${s.caption_replaced}\n\nPhoto/image tak dikira dalam total file utama.`;
  return telegram('sendMessage', { chat_id: chatId, text });
}

async function sendPending(chatId) {
  const items = await listPending(20);
  if (!items.length) return telegram('sendMessage', { chat_id: chatId, text: '✅ Tak ada item pending.' });

  const body = items.map((item, i) => {
    const icon = item.status === 'FAILED' ? '🔴' : '🟡';
    const type = item.media_kind === 'document' ? '📦' : '🖼';
    return `${i + 1}. ${icon} ${type} ${item.file_name || item.generated_title || 'Untitled'} — ${item.status}`;
  }).join('\n');

  return telegram('sendMessage', {
    chat_id: chatId,
    text: `⏳ PENDING (${items.length})\n\n${body}`.slice(0, 3900),
    reply_markup: inlineKeyboard([[{ text: '🚀 SEND ALL', callback_data: 'sendall' }]]),
  });
}

async function sendMemories(chatId) {
  const memories = await listMemories(chatId, 30);
  if (!memories?.length) {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: '🧠 Belum ada long-term memory. Cakap je “ingat lepas ni…” untuk ajar aku sesuatu yang kekal.',
    });
  }

  const body = memories.map((m) => `#${m.id} — ${m.content}`).join('\n\n').slice(0, 3800);
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `🧠 LONG-TERM MEMORY\n\n${body}\n\nPadam: /forget ID`,
  });
}

function formatAiTestResult(result) {
  if (result?.ok) {
    return `✅ Gemini connection OK\nModel: ${result.model}\nResponse time: ${result.ms}ms\nReply: ${result.answer}`;
  }
  if (result?.error) return `❌ Gemini test gagal\n${result.error}`;
  const attempts = (result?.attempts || []).map((x) => `• ${x.model}: ${x.error} (${x.ms}ms)`).join('\n');
  return `❌ Gemini test gagal untuk semua model.\n\n${attempts || 'Tak ada detail.'}`.slice(0, 3900);
}

function fallbackMediaTitle(caption, fileName) {
  const lines = String(caption || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'));
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
    parse_mode: 'HTML',
    text: `<b>Abang Render Coordinator</b>\n\nAku sekarang AI-first assistant. Kau boleh sembang biasa terus — tanya total file, suruh kemaskan title, ajar rule, minta preview atau tanya apa-apa pasal workflow. Command cuma shortcut, bukan syarat.\n\nBila ada item, aku akan tunjuk preview dengan button SEND sebelum publish.\n\n/setcaption — set footer dengan hidden links\n/setrules — set arahan asas title\n/stats — shortcut statistik\n/pending — shortcut pending\n/memories — tengok memory\n/clearchat — clear chat history\n/aitest — test Gemini\n/whoami — Telegram user ID`,
  });
}
