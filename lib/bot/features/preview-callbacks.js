import {
  getProfileForItem,
  profileOptionFromCallback,
  toggleFormatOption,
} from '../../format-profiles.js';
import { getQueueItem, listPending, setSetting, updateQueueItem } from '../../store.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { debugCallback } from '../core/debug.js';
import { isAdminUser } from '../core/auth.js';
import { clearAdminState, keepFocus } from './context.js';
import { reprocessItemWithProfile, showCompactMenu, showEditMenu } from './preview-ui.js';
import { sendItem } from './send-one.js';

export async function handlePreviewCallback(query) {
  const message = query?.message;
  await debugCallback('feature_callback_enter', {
    callback_query_id: query?.id || null,
    data: query?.data || '',
    from_id: query?.from?.id || null,
    chat_id: message?.chat?.id || null,
    message_id: message?.message_id || null,
  });

  if (!message || !isAdminUser(query.from)) return false;

  const chatId = message.chat.id;
  const data = String(query.data || '');
  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  if (data === 'noop') return true;
  if (data === 'pending') {
    await sendPending(chatId);
    return true;
  }

  const [action, id] = data.split(':');
  if (!id) return false;

  if (action === 'edit') {
    await showEditMenu(id, chatId, message.message_id);
    return true;
  }

  if (action === 'back') {
    await showCompactMenu(id, chatId, message.message_id);
    return true;
  }

  if (action === 'resend') {
    await clearAdminState();
    await sendItem(id, chatId, { forceResend: true });
    return true;
  }

  if (action.startsWith('fmt_')) {
    const item = await getQueueItem(id);
    if (!item) {
      await telegram('sendMessage', { chat_id: chatId, text: 'Item tu dah tak jumpa.' });
      return true;
    }

    const profile = await getProfileForItem(item);
    if (!profile) {
      await telegram('sendMessage', { chat_id: chatId, text: 'Format profile tak jumpa.' });
      return true;
    }

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
      return true;
    }

    if (action === 'fmt_editfooter') {
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
      return true;
    }

    const option = profileOptionFromCallback(action);
    if (!option) return false;

    const updatedProfile = await toggleFormatOption(profile.id, option);
    await reprocessItemWithProfile(item.id, updatedProfile);
    await keepFocus(item.id);
    await showEditMenu(item.id, chatId, message.message_id);
    return true;
  }

  if (action === 'send') {
    await clearAdminState();
    await sendItem(id, chatId);
    return true;
  }

  if (action === 'skip') {
    await updateQueueItem(id, { status: 'SKIPPED' });
    await clearAdminState();
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: inlineKeyboard([[{ text: 'SKIPPED', callback_data: 'noop' }]]),
    });
    return true;
  }

  if (action === 'teach') {
    await keepFocus(id);
    await telegram('sendMessage', {
      chat_id: chatId,
      text: 'Button lama tu ignore je. Cakap terus apa kau nak ubah, atau guna setting dekat preview baru.',
    });
    return true;
  }

  return false;
}

async function sendPending(chatId) {
  const items = await listPending(20);
  if (!items.length) {
    return telegram('sendMessage', { chat_id: chatId, text: 'Tak ada item pending.' });
  }

  const body = items
    .map((item, i) => `${i + 1}. ${item.file_name || item.generated_title || 'Untitled'} — ${item.status}`)
    .join('\n');
  return telegram('sendMessage', {
    chat_id: chatId,
    text: `Pending sekarang (${items.length})\n\n${body}`.slice(0, 3900),
  });
}
