import { waitUntil } from '@vercel/functions';
import { getQueueItem, getSetting, setSetting, updateQueueItem } from '../../store.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { isAdminUser } from '../core/auth.js';
import { getRecaptionSession, setRecaptionSessionStatus } from './recaption-collection.js';
import { kickRecaptionWorker } from './recaption-runner.js';
import { kickImmediateMediaWorker } from './immediate-media-worker.js';
import {
  PIPELINE_REASONS,
  getPipelineState,
  resumePipeline,
  setDirectAiBypass,
} from './pipeline-controller.js';
import { setRecaptionAiBypass } from '../../ai-gate.js';

const WAIT_PREFIX = 'recaption_ai_wait_v1:';

export async function handleAiLimitCallback(query) {
  const message = query?.message;
  const data = String(query?.data || '');
  if (!message || !isAdminUser(query.from)) return false;

  if (data.startsWith('ai_continue_direct:')) {
    return handleDirectAiContinue(query);
  }
  if (!data.startsWith('ai_continue:')) return false;

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

async function handleDirectAiContinue(query) {
  const message = query.message;
  const chatId = message.chat.id;
  const itemId = String(query.data || '').slice('ai_continue_direct:'.length).trim();
  if (!itemId) return false;

  await telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});

  const item = await getQueueItem(itemId);
  if (!item || String(item.admin_chat_id) !== String(chatId)) {
    await telegram('sendMessage', { chat_id: chatId, text: 'Item direct queue tu dah tak jumpa.' }).catch(() => {});
    return true;
  }

  const pipeline = await getPipelineState(chatId);
  if (!pipeline?.paused || pipeline.reason !== PIPELINE_REASONS.AI_LIMIT) {
    await telegram('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: inlineKeyboard([[{ text: '✅ AI WAIT DAH SELESAI', callback_data: 'noop' }]]),
    }).catch(() => {});
    return true;
  }

  await setDirectAiBypass(chatId, item.id, true);
  await updateQueueItem(item.id, {
    status: 'PENDING',
    immediate_prepared_at: null,
    error_message: null,
  });
  await resumePipeline(chatId, { allowedReasons: [PIPELINE_REASONS.AI_LIMIT] });

  await telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: message.message_id,
    reply_markup: inlineKeyboard([[{ text: '✅ TERUSKAN TANPA AI', callback_data: 'noop' }]]),
  }).catch(() => {});
  await telegram('sendMessage', {
    chat_id: chatId,
    text: '▶️ Direct caption queue sambung. Bypass AI hanya untuk item yang tersekat ini; item selepasnya akan cuba AI seperti biasa.',
  }).catch(() => {});

  waitUntil(kickImmediateMediaWorker(chatId).catch(async (error) => {
    console.error('Direct AI bypass worker kick failed:', error?.message || error);
    await telegram('sendMessage', {
      chat_id: chatId,
      text: `❌ Direct queue tak dapat sambung selepas AI bypass. Item masih PENDING dan selamat. ${String(error?.message || error).slice(0, 180)}`,
    }).catch(() => {});
  }));

  return true;
}
