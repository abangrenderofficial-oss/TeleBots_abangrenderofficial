import { telegram, isAdminMessage, inlineKeyboard } from '../lib/telegram.js';
import { buildCaption } from '../lib/caption.js';
import { agentAssistant } from '../lib/agent.js';
import { testGeminiConnection } from '../lib/assistant.js';
import { duplicateNotice, inspectIncomingDuplicate } from '../lib/duplicates.js';
import { telegramTextToHtml } from '../lib/entities.js';
import {
  formatProfileKeyboardRows,
  getFormatProfile,
  getProfileForItem,
  processMediaWithProfile,
  profileOptionFromCallback,
  resolveFormatProfile,
  saveItemFormatContext,
  setFormatFooter,
  toggleFormatOption,
} from '../lib/format-profiles.js';
import {
  addFormatRemoveTerms,
  applyFormatRemoveTerms,
  clearFormatRemoveTerms,
  getFormatRemoveTerms,
  removeWordButtonLabel,
} from '../lib/remove-words.js';
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

const BUILD_VERSION = 'format-learning-v2-group-auto-destination';
const CALLBACK_DEBUG_KEY = 'telegram_callback_debug';

async function debugCallback(stage, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    stage,
    ...details,
  };

  try {
    const current = await getSetting(CALLBACK_DEBUG_KEY);
    const events = Array.isArray(current?.events) ? current.events : [];
    await setSetting(CALLBACK_DEBUG_KEY, {
      last: entry,
      events: [...events, entry].slice(-30),
    });
  } catch (error) {
    console.error('Callback debug write failed:', error?.message || error);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const update = req.body || {};
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) {
      const query = update.callback_query;
      await debugCallback('webhook_callback_received', {
        callback_query_id: query.id || null,
        data: query.data || '',
        from_id: query.from?.id || null,
        chat_id: query.message?.chat?.id || null,
        message_id: query.message?.message_id || null,
      });
      await handleCallback(query);
    }
    return res.status(200).json({ ok: true, build: BUILD_VERSION });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    await debugCallback('webhook_handler_error', {
      error: String(error?.message || error).slice(0, 800),
    });
    return res.status(200).json({ ok: true, handled: false, build: BUILD_VERSION });
  }
}

async function handleMessage(message) {
  if (message.chat?.type !== 'private') return handleGroupMessage(message);

  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (text === '/whoami') {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: `Telegram User ID: ${message.from?.id ?? 'unknown'}`,
    });
  }

  if (!isAdminMessage(message)) return;

  if (text === '/version') {
    return telegram('sendMessage', { chat_id: chatId, text: `Build: ${BUILD_VERSION}` });
  }

  if (text === '/start' || text === '/help') return sendHelp(chatId);

  if (text === '/aitest') {
    await telegram('sendMessage', { chat_id: chatId, text: 'Aku test Gemini jap...' });
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
    return telegram('sendMessage', { chat_id: chatId, text: `Okay, aku ingat. Memory #${saved.id} dah simpan.` });
  }

  if (text?.startsWith('/forget ')) {
    const id = Number(text.slice('/forget '.length).trim());
    if (!Number.isInteger(id) || id <= 0) {
      return telegram('sendMessage', { chat_id: chatId, text: 'Memory ID tu tak valid.' });
    }
    const deleted = await deleteMemory(chatId, id);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: deleted?.length ? `Memory #${id} dah padam.` : `Memory #${id} tak jumpa.`,
    });
  }

  if (text === '/clearchat') {
    await clearChatHistory(chatId);
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Chat history AI dah clear. Memory lama masih ada.',
    });
  }

  if (text === '/setcaption') {
    await setSetting('admin_state', { mode: 'SET_CAPTION' });
    return telegram('sendMessage', {
      chat_id: chatId,
      text: 'Send caption/footer exact macam kau nak. Hidden link, bold, italic aku simpan sekali.',
    });
  }

  const state = await getSetting('admin_state');

  if (state?.mode === 'ADD_FORMAT_REMOVE_WORDS' && text) {
    const item = await getQueueItem(state.item_id);
    const profile = await getFormatProfile(state.profile_id);
    if (!item || !profile) {
      await setSetting('admin_state', null);
      return telegram('sendMessage', { chat_id: chatId, text: 'Item atau format tu dah tak jumpa.' });
    }

    if (/^(?:clear|reset|padam semua|buang semua)$/i.test(text)) {
      await clearFormatRemoveTerms(profile.id);
    } else {
      await addFormatRemoveTerms(profile.id, text);
    }

    await reprocessItemWithProfile(item.id, profile);
    await keepFocus(item.id);
    await deleteHelperPrompt(chatId, state.prompt_message_id);
    return sendPreview(item.id, chatId);
  }

  if (state?.mode === 'EDIT_FORMAT_FOOTER' && text) {
    const item = await getQueueItem(state.item_id);
    const profile = await getFormatProfile(state.profile_id);
    if (!item || !profile) {
      await setSetting('admin_state', null);
      return telegram('sendMessage', { chat_id: chatId, text: 'Item atau format tu dah tak jumpa. Send file balik jap.' });
    }

    const html = telegramTextToHtml(message.text, message.entities || []);
    const updatedProfile = await setFormatFooter(profile.id, html);
    await reprocessItemWithProfile(item.id, updatedProfile);
    await keepFocus(item.id);
    await deleteHelperPrompt(chatId, state.prompt_message_id);
    return sendPreview(item.id, chatId);
  }

  if (state?.mode === 'SET_CAPTION' && text) {
    const html = telegramTextToHtml(message.text, message.entities || []);
    await setSetting('caption_footer_html', html);
    const item = state?.item_id ? await getQueueItem(state.item_id) : await getLatestQueueItem(chatId);

    if (item) {
      const finalCaption = await buildCaption(item.generated_title || 'Untitled');
      await updateQueueItem(item.id, { final_caption_html: finalCaption, caption_replaced: true });
      await keepFocus(item.id);
      return sendPreview(item.id, chatId);
    }

    await setSetting('admin_state', null);
    return telegram('sendMessage', { chat_id: chatId, text: 'Okay, caption global dah simpan.' });
  }

  if (hasMedia(message)) return prepareMedia(message);
  if (text) return handleAgentText(chatId, message, state);
}

async function handleGroupMessage(message) {
  const chat = message.chat;
  if (!['group', 'supergroup'].includes(chat?.type)) return;
  if (!isAdminMessage(message)) return;

  const text = String(message.text || '').trim();
  const connectCommand = /^\/connect(?:@\w+)?(?:\s|$)/i.test(text);
  const botAdded = Array.isArray(message.new_chat_members)
    && message.new_chat_members.some((member) => member?.is_bot);

  if (!connectCommand && !botAdded) return;

  const destination = String(chat.id);
  await setSetting('destination_chat_id', destination);
  await setSetting('destination_chat_info', {
    id: destination,
    title: chat.title || null,
    type: chat.type || null,
    connected_at: new Date().toISOString(),
    connected_by: message.from?.id || null,
    method: connectCommand ? 'connect_command' : 'bot_added',
  });

  await debugCallback('destination_auto_connected', {
    destination,
    title: chat.title || null,
    type: chat.type || null,
    method: connectCommand ? 'connect_command' : 'bot_added',
  });

  if (connectCommand) {
    return telegram('sendMessage', {
      chat_id: chat.id,
      text: 'Connected. Group ni dah jadi destination SEND.',
    });
  }
}

async function handleAgentText(chatId, message, state) {
  const text = message.text?.trim() || '';
  const focusedItemId = state?.mode === 'FOCUS_ITEM' && state?.item_id ? state.item_id : null;

  await ensureKlPersona(chatId);
  telegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  const result = await agentAssistant({
    chatId,
    text,
    focusedItemId,
    ownerText: message.text || text,
    ownerEntities: message.entities || [],
  });

  if (result.focusedItemId) await keepFocus(result.focusedItemId);
  if (result.reply) await sendAiReplyBubbles(chatId, result.reply);

  for (const effect of result.effects || []) {
    if (effect.type === 'preview_item' && effect.item_id) {
      await keepFocus(effect.item_id);
      await sendPreview(effect.item_id, chatId);
    } else if (effect.type === 'confirm_send_all') {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: effect.count
          ? `Ada ${effect.count} item ready. Kalau confirm, tekan SEND ALL.`
          : 'Tak ada item ready nak send.',
        reply_markup: effect.count
          ? inlineKeyboard([[{ text: `🚀 SEND ALL (${effect.count})`, callback_data: 'sendall' }]])
          : undefined,
      });
    }
  }
}

async function ensureKlPersona(chatId) {
  const seeded = await getSetting(`persona_kl_seeded:${chatId}`);
  if (seeded) return;

  await addMemory(
    chatId,
    'Reply macam AI general-purpose biasa dan boleh jawab soalan luar kerja bot juga. Guna bahasa pasar Kuala Lumpur yang natural, santai aku/kau, ringkas macam chat Telegram. Elak karangan panjang; kalau perlu pecahkan jawapan jadi beberapa mesej pendek.',
  ).catch(() => {});
  await setSetting(`persona_kl_seeded:${chatId}`, true).catch(() => {});
}

async function sendAiReplyBubbles(chatId, text) {
  const bubbles = splitIntoBubbles(text);
  for (const bubble of bubbles) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: bubble,
      disable_web_page_preview: true,
    });
  }
}

function splitIntoBubbles(text) {
  const clean = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const out = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= 330) {
      out.push(paragraph);
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
    let current = '';
    for (const sentence of sentences) {
      if (!current) current = sentence;
      else if (`${current} ${sentence}`.length <= 330) current += ` ${sentence}`;
      else {
        out.push(current);
        current = sentence;
      }
    }
    if (current) out.push(current);
  }

  if (!out.length) out.push(clean.slice(0, 3900));
  return out.slice(0, 5).map((x) => x.slice(0, 3900));
}

async function keepFocus(itemId) {
  return setSetting('admin_state', { mode: 'FOCUS_ITEM', item_id: itemId });
}

async function deleteHelperPrompt(chatId, messageId) {
  if (!messageId) return;
  await telegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
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

  const beforeAi = await inspectIncomingDuplicate(duplicateInput);
  if (beforeAi.kind === 'webhook_replay') return;
  if (beforeAi.kind === 'exact_file') return handleExactDuplicate(message, beforeAi);

  const resolved = await resolveFormatProfile({
    caption: message.caption || '',
    fileName: media.fileName || '',
    mediaKind: media.kind,
  });

  const baseProcessed = await processMediaWithProfile({
    caption: message.caption || '',
    fileName: media.fileName || '',
    profile: resolved.profile,
  });
  const processed = await applyFormatRemoveTerms(resolved.profile.id, baseProcessed);

  const duplicateResult = await inspectIncomingDuplicate({
    ...duplicateInput,
    generatedTitle: processed.title || '',
  });
  if (duplicateResult.kind === 'webhook_replay') return;
  if (duplicateResult.kind === 'exact_file') return handleExactDuplicate(message, duplicateResult);

  const item = await createQueueItem({
    admin_chat_id: message.chat.id,
    source_chat_id: message.chat.id,
    source_message_id: message.message_id,
    media_kind: media.kind,
    file_name: media.fileName || null,
    file_unique_id: media.fileUniqueId || null,
    original_caption: message.caption || null,
    generated_title: processed.title || null,
    final_caption_html: processed.finalCaptionHtml || null,
    status: 'READY',
    caption_replaced: true,
  });

  await saveItemFormatContext(item.id, {
    profile_id: resolved.profile.id,
    signature: resolved.signature,
  });
  await keepFocus(item.id);

  if (resolved.isNew) {
    await telegram('sendMessage', {
      chat_id: message.chat.id,
      text: `${resolved.profile.name} baru aku detect. Setting dekat preview ni khas untuk format ni. Kau ajar sekali, format sama lepas ni aku ingat.`,
    });
  }

  if (['exact_file_unsent', 'same_serial', 'same_title'].includes(duplicateResult.kind)) {
    const notice = duplicateNotice(duplicateResult);
    if (notice) await telegram('sendMessage', { chat_id: message.chat.id, text: notice });
  }

  return sendPreview(item.id, message.chat.id);
}

async function handleExactDuplicate(message, duplicateResult) {
  const oldItem = duplicateResult.match;
  if (oldItem?.id) await keepFocus(oldItem.id).catch(() => {});

  let deleted = false;
  try {
    await telegram('deleteMessage', {
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
    deleted = true;
  } catch (error) {
    console.error('Duplicate auto-delete failed:', error?.message || error);
  }

  const notice = duplicateNotice(duplicateResult);
  const resultText = deleted
    ? 'Copy baru tu aku delete sebab benda sama memang dah pernah berjaya SEND ke group.'
    : 'Benda ni memang dah pernah SENT ke group, tapi Telegram tak bagi aku delete mesej baru tu.';

  return telegram('sendMessage', {
    chat_id: message.chat.id,
    text: `${notice}\n\n${resultText}`.slice(0, 3900),
  });
}

async function reprocessItemWithProfile(itemId, profile) {
  const item = await getQueueItem(itemId);
  if (!item) throw new Error('Item tak jumpa');

  const baseProcessed = await processMediaWithProfile({
    caption: item.original_caption || '',
    fileName: item.file_name || '',
    profile,
  });
  const processed = await applyFormatRemoveTerms(profile.id, baseProcessed);

  return updateQueueItem(item.id, {
    generated_title: processed.title || null,
    final_caption_html: processed.finalCaptionHtml || null,
    caption_replaced: true,
    status: item.status === 'SENT' ? 'SENT' : 'READY',
  });
}

async function sendPreview(itemId, chatId) {
  const item = await getQueueItem(itemId);
  if (!item) return;

  const profile = await getProfileForItem(item);
  const removeTerms = await getFormatRemoveTerms(profile.id);
  const rows = formatProfileKeyboardRows(profile, item.id);
  rows.splice(Math.max(0, rows.length - 1), 0, [
    { text: removeWordButtonLabel(removeTerms), callback_data: `fmt_removeword:${item.id}` },
  ]);

  if (item.preview_message_id) {
    await telegram('deleteMessage', {
      chat_id: chatId,
      message_id: item.preview_message_id,
    }).catch(() => {});
  }

  const payload = {
    chat_id: chatId,
    from_chat_id: item.source_chat_id,
    message_id: item.source_message_id,
    parse_mode: 'HTML',
    disable_notification: true,
    reply_markup: inlineKeyboard(rows),
  };
  payload.caption = item.final_caption_html || '';

  const copied = await telegram('copyMessage', payload);
  await updateQueueItem(item.id, { preview_message_id: copied.message_id });
}

async function handleCallback(query) {
  const message = query.message;
  await debugCallback('handle_callback_enter', {
    callback_query_id: query.id || null,
    data: query.data || '',
    has_message: Boolean(message),
    from_id: query.from?.id || null,
    chat_id: message?.chat?.id || null,
    message_id: message?.message_id || null,
  });

  if (!message) {
    await debugCallback('handle_callback_rejected_no_message', { data: query.data || '' });
    return;
  }

  if (!isAdminMessage({ from: query.from })) {
    await debugCallback('handle_callback_rejected_not_admin', {
      data: query.data || '',
      from_id: query.from?.id || null,
    });
    return;
  }

  const chatId = message.chat.id;
  const data = query.data || '';
  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(async (error) => {
    await debugCallback('answer_callback_failed', {
      data,
      error: String(error?.message || error).slice(0, 500),
    });
  });

  if (data === 'noop') return;
  if (data === 'pending') return sendPending(chatId);
  if (data === 'sendall') return sendAll(chatId);

  const [action, id] = data.split(':');
  await debugCallback('callback_parsed', {
    data,
    action: action || null,
    item_id: id || null,
    chat_id: chatId,
  });

  if (!id) {
    await debugCallback('callback_rejected_missing_item_id', { data, action: action || null });
    return;
  }

  if (action.startsWith('fmt_')) {
    const item = await getQueueItem(id);
    if (!item) return telegram('sendMessage', { chat_id: chatId, text: 'Item tu dah tak jumpa.' });

    const profile = await getProfileForItem(item);
    if (!profile) return telegram('sendMessage', { chat_id: chatId, text: 'Format profile tak jumpa.' });

    if (action === 'fmt_removeword') {
      const prompt = await telegram('sendMessage', {
        chat_id: chatId,
        text: `Send word/ayat yang ${profile.name} wajib buang. Kalau banyak, satu line satu. Kalau nak kosongkan semua, send “clear”.`,
      });
      await setSetting('admin_state', {
        mode: 'ADD_FORMAT_REMOVE_WORDS',
        item_id: item.id,
        profile_id: profile.id,
        prompt_message_id: prompt?.message_id || null,
      });
      return;
    }

    if (action === 'fmt_footer' || action === 'fmt_editfooter') {
      const prompt = await telegram('sendMessage', {
        chat_id: chatId,
        text: `Send caption yang kau nak letak bawah tajuk untuk ${profile.name}.`,
      });
      await setSetting('admin_state', {
        mode: 'EDIT_FORMAT_FOOTER',
        item_id: item.id,
        profile_id: profile.id,
        prompt_message_id: prompt?.message_id || null,
      });
      return;
    }

    const option = profileOptionFromCallback(action);
    if (!option) return;

    const updatedProfile = await toggleFormatOption(profile.id, option);
    await reprocessItemWithProfile(item.id, updatedProfile);
    await keepFocus(item.id);
    return sendPreview(item.id, chatId);
  }

  if (action === 'send') {
    await debugCallback('send_branch_enter', {
      item_id: id,
      chat_id: chatId,
      preview_message_id: message.message_id || null,
    });
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
      text: 'Button lama tu ignore je. Cakap terus apa kau nak ubah, atau guna setting dekat preview baru.',
    });
  }

  await debugCallback('callback_unhandled_action', { data, action, item_id: id });
}

async function sendItem(id, chatId) {
  await debugCallback('send_item_start', { item_id: id, chat_id: chatId });

  const item = await getQueueItem(id);
  if (!item) {
    await debugCallback('send_item_missing', { item_id: id, chat_id: chatId });
    return;
  }
  if (item.status === 'SENT') {
    await debugCallback('send_item_already_sent', { item_id: id, chat_id: chatId });
    return;
  }

  const dbDestination = await getSetting('destination_chat_id');
  const envDestination = process.env.DESTINATION_CHAT_ID;
  const destination = dbDestination || envDestination;

  await debugCallback('send_destination_resolved', {
    item_id: id,
    item_status: item.status || null,
    has_db_destination: Boolean(dbDestination),
    has_env_destination: Boolean(envDestination),
    destination: destination ? String(destination) : null,
  });

  if (!destination) {
    await debugCallback('send_blocked_no_destination', { item_id: id, chat_id: chatId });
    await keepFocus(id);
    return telegram('sendMessage', { chat_id: chatId, text: 'Destination belum set lagi. Dalam group target, hantar /connect sekali.' });
  }

  try {
    await debugCallback('send_copy_start', {
      item_id: id,
      destination: String(destination),
      source_chat_id: item.source_chat_id || null,
      source_message_id: item.source_message_id || null,
    });

    const payload = {
      chat_id: destination,
      from_chat_id: item.source_chat_id,
      message_id: item.source_message_id,
      parse_mode: 'HTML',
      caption: item.final_caption_html || '',
    };

    const sent = await telegram('copyMessage', payload);

    await debugCallback('send_copy_success', {
      item_id: id,
      destination: String(destination),
      destination_message_id: sent?.message_id || null,
    });

    await updateQueueItem(id, {
      status: 'SENT',
      destination_chat_id: String(destination),
      destination_message_id: sent.message_id,
      sent_at: new Date().toISOString(),
      error_message: null,
    });

    await setSetting('admin_state', null);
    await debugCallback('send_complete', {
      item_id: id,
      destination: String(destination),
      destination_message_id: sent?.message_id || null,
    });

    return telegram('sendMessage', {
      chat_id: chatId,
      text: `SENT\n${item.file_name || item.generated_title || 'Item'}`,
    });
  } catch (error) {
    const errorText = String(error?.message || error).slice(0, 1000);
    await debugCallback('send_failed', {
      item_id: id,
      destination: String(destination),
      error: errorText,
    });
    await updateQueueItem(id, { status: 'FAILED', error_message: errorText });
    await keepFocus(id);
    return telegram('sendMessage', { chat_id: chatId, text: `FAILED\n${errorText}` });
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
    text: `Send all settle. Sent ${sent}, failed ${failed}.`,
  });
}

async function sendStats(chatId, intro = '') {
  const s = await stats();
  const body = `Total file: ${s.total}\nSent: ${s.sent}\nPending: ${s.pending}\nFailed: ${s.failed}\nSkipped: ${s.skipped || 0}\nCaption replaced: ${s.caption_replaced}\n\nPhoto/image tak masuk total file utama.`;
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
      text: 'Belum ada long-term memory.',
    });
  }

  const body = memories.map((m) => `#${m.id} — ${m.content}`).join('\n\n').slice(0, 3800);
  return telegram('sendMessage', { chat_id: chatId, text: `Memory aku sekarang:\n\n${body}` });
}

function formatAiTestResult(result) {
  if (result?.ok) {
    return `Gemini OK\nModel: ${result.model}\n${result.ms}ms\nReply: ${result.answer}`;
  }
  if (result?.error) return `Gemini test gagal\n${result.error}`;
  const attempts = (result?.attempts || []).map((x) => `• ${x.model}: ${x.error} (${x.ms}ms)`).join('\n');
  return `Gemini test gagal semua model.\n\n${attempts || 'Tak ada detail.'}`.slice(0, 3900);
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
    text: 'Aku AI assistant kau. Sembang je macam biasa, benda luar pasal bot pun boleh tanya.\n\nSetiap format file belajar setting sendiri: Tajuk, No Siri, Translate, Buang #, Tambah Caption dan Remove Word. Remove Word simpan word/ayat wajib buang untuk format tu.\n\nBenda exact sama cuma auto-delete kalau benda asal memang dah berjaya SENT ke group.\n\nGroup destination: invite bot, kemudian /connect dalam group sekali.\n\n/version untuk check build yang tengah live.',
  });
}
