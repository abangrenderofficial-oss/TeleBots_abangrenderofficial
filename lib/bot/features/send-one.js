import { isSendPaused } from '../../send-control.js';
import { getQueueItem, getSetting, setSetting, updateQueueItem } from '../../store.js';
import { telegram } from '../../telegram.js';
import { debugCallback } from '../core/debug.js';
import { keepFocus } from './context.js';

export async function sendItem(id, chatId, options = {}) {
  const forceResend = Boolean(options.forceResend);
  await debugCallback('send_item_start', {
    item_id: id,
    chat_id: chatId,
    force_resend: forceResend,
  });

  if (await isSendPaused(chatId)) {
    await debugCallback('send_item_paused', { item_id: id, chat_id: chatId });
    await telegram('sendMessage', {
      chat_id: chatId,
      text: '⏸ SEND tengah STOP. Guna /resume dulu.',
    });
    return { ok: false, paused: true };
  }

  const item = await getQueueItem(id);
  if (!item) {
    await debugCallback('send_item_missing', { item_id: id, chat_id: chatId });
    return { ok: false, missing: true };
  }
  if (item.status === 'SENT' && !forceResend) {
    await debugCallback('send_item_already_sent', { item_id: id, chat_id: chatId });
    return { ok: true, skipped: true };
  }

  const dbDestination = await getSetting('destination_chat_id');
  const envDestination = process.env.DESTINATION_CHAT_ID;
  const destination = dbDestination || envDestination;

  await debugCallback('send_destination_resolved', {
    item_id: id,
    chat_id: chatId,
    destination: destination ? String(destination) : null,
  });

  if (!destination) {
    await debugCallback('send_blocked_no_destination', { item_id: id, chat_id: chatId });
    await keepFocus(id);
    await telegram('sendMessage', {
      chat_id: chatId,
      text: 'Destination belum set lagi. Dalam group target, hantar /connect sekali.',
    });
    return { ok: false, no_destination: true };
  }

  try {
    await debugCallback('send_copy_start', {
      item_id: id,
      destination: String(destination),
      source_chat_id: item.source_chat_id || null,
      source_message_id: item.source_message_id || null,
      force_resend: forceResend,
    });

    const sent = await telegram('copyMessage', {
      chat_id: destination,
      from_chat_id: item.source_chat_id,
      message_id: item.source_message_id,
      parse_mode: 'HTML',
      caption: item.final_caption_html || '',
      __force_resend: forceResend,
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
      force_resend: forceResend,
    });

    return { ok: true, sent: true, destination_message_id: sent?.message_id || null };
  } catch (error) {
    const errorText = String(error?.message || error).slice(0, 1000);
    await debugCallback('send_failed', {
      item_id: id,
      destination: String(destination),
      error: errorText,
      force_resend: forceResend,
    });

    if (item.status === 'SENT') {
      await updateQueueItem(id, { status: 'SENT', error_message: errorText });
    } else {
      await updateQueueItem(id, { status: 'FAILED', error_message: errorText });
    }
    await keepFocus(id);
    await telegram('sendMessage', { chat_id: chatId, text: `FAILED\n${errorText}` });
    return { ok: false, error: errorText };
  }
}
