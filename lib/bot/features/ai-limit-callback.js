import { waitUntil } from '@vercel/functions';
import { getSetting, setSetting, updateQueueItem } from '../../store.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { isAdminUser } from '../core/auth.js';
import { getRecaptionSession, setRecaptionSessionStatus } from './recaption-collection.js';
import { kickRecaptionWorker } from './recaption-runner.js';
import { setRecaptionAiBypass } from '../../ai-gate.js';

const WAIT_PREFIX = 'recaption_ai_wait_v1:';

export async function handleAiLimitCallback(query) {
  const message = query?.message;
  const data = String(query?.data || '');
  if (!message || !isAdminUser(query.from) || !data.startsWith('ai_continue:')) return false;

  const sessionId = data.slice('ai_continue:'.length).trim();
  if (!sessionId) return false;

  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  const chatId = message.chat.id;
  const session = await getRecaptionSession(sessionId);
  if (!session || String(session.admin_chat_id) !== String(chatId)) {
    await telegram('sendMessage', { chat_id: chatId, text: 'Session recaption tu dah tak jumpa atau bukan session chat ni.' }).catch(() => {});
    return true;
  }

  const wait = await getSetting(`${WAIT_PREFIX}${sessionId}`).catch(() => null);
  if (!wait?.paused) {
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: inlineKeyboard([[{ text: '✅ AI BYPASS DAH AKTIF', callback_data: 'noop' }]]),
    }).catch(() => {});
    return true;
  }

  await setRecaptionAiBypass(sessionId, true);
  if (wait.item_id) {
    await updateQueueItem(wait.item_id, {
      status: 'PENDING',
      error_message: null,
    }).catch(() => {});
  }
  await setSetting(`${WAIT_PREFIX}${sessionId}`, {
    ...wait,
    paused: false,
    continued_without_ai: true,
    continued_at: new Date().toISOString(),
  }).catch(() => {});

  const runnable = await setRecaptionSessionStatus(sessionId, 'PROCESSING');

  await telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: message.message_id,
    reply_markup: inlineKeyboard([[{ text: '✅ TERUSKAN TANPA AI', callback_data: 'noop' }]]),
  }).catch(() => {});

  await telegram('sendMessage', {
    chat_id: chatId,
    text: '▶️ Sambung batch tanpa AI. Item biasa tetap diproses normal; translation yang perlukan AI akan kekal tajuk asal, dan gambar kosong yang perlukan vision akan diteruskan tanpa tajuk AI.',
  }).catch(() => {});

  waitUntil(kickRecaptionWorker(runnable || session).catch(async (error) => {
    console.error('AI bypass recaption kick failed:', error?.message || error);
    await telegram('sendMessage', {
      chat_id: chatId,
      text: `❌ Worker tak dapat sambung selepas AI bypass. Session masih selamat; tekan /recaption untuk retry. ${String(error?.message || error).slice(0, 180)}`,
    }).catch(() => {});
  }));

  return true;
}
