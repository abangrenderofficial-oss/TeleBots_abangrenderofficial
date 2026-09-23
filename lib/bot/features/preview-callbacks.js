import { waitUntil } from '@vercel/functions';
import {
  getFormatProfile,
  getProfileForItem,
  profileOptionFromCallback,
  toggleFormatOption,
} from '../../format-profiles.js';
import { getQueueItem, listPending, setSetting, updateQueueItem } from '../../store.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { debugCallback } from '../core/debug.js';
import { isAdminUser } from '../core/auth.js';
import { clearAdminState, keepFocus } from './context.js';
import {
  kickFormatBatchApply,
  startFormatBatchApply,
} from './format-batch-apply.js';
import { confirmFormatStep } from './format-gate.js';
import {
  formatManagerOptionFromAction,
  sendFormatManagerList,
  showFormatManager,
} from './format-manager.js';
import { reprocessItemWithProfile, showCompactMenu, showEditMenu } from './preview-ui.js';
import { sendItem } from './send-one.js';
import {
  getSentSyncMode,
  setSentSyncMode,
  syncSentItemById,
} from './sent-sync.js';

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

  if (action === 'fmtmgr_page') {
    await sendFormatManagerList(chatId, {
      messageId: message.message_id,
      page: Number(id) || 0,
    });
    return true;
  }

  if (action === 'fmtmgr_open') {
    await showFormatManager(id, chatId, message.message_id);
    return true;
  }

  if (action === 'fmtmgr_editfooter') {
    const profile = await getFormatProfile(id);
    if (!profile) {
      await telegram('sendMessage', { chat_id: chatId, text: 'Format profile tak jumpa.' });
      return true;
    }

    const prompt = await telegram('sendMessage', {
      chat_id: chatId,
      text: `Send caption yang kau nak letak bawah tajuk untuk ${profile.name}.`,
    });
    await setSetting('admin_state', {
      mode: 'EDIT_MANAGED_FORMAT_FOOTER',
      profile_id: profile.id,
      manager_message_id: message.message_id,
      prompt_message_id: prompt?.message_id || null,
    });
    return true;
  }

  if (action === 'fmtmgr_removeword') {
    const profile = await getFormatProfile(id);
    if (!profile) {
      await telegram('sendMessage', { chat_id: chatId, text: 'Format profile tak jumpa.' });
      return true;
    }

    const prompt = await telegram('sendMessage', {
      chat_id: chatId,
      text: `Send word/ayat yang ${profile.name} wajib buang. Kalau banyak, satu line satu. Kalau nak kosongkan semua, send “clear”.`,
    });
    await setSetting('admin_state', {
      mode: 'EDIT_MANAGED_FORMAT_REMOVE_WORDS',
      profile_id: profile.id,
      manager_message_id: message.message_id,
      prompt_message_id: prompt?.message_id || null,
    });
    return true;
  }

  if (action === 'fmtmgr_applybatch') {
    try {
      const result = await startFormatBatchApply({ chatId, profileId: id });
      if (!result.ok) {
        const reasonText = result.reason === 'session_processing'
          ? '⏳ RECAPTION batch terbaru masih PROCESSING. Tunggu ia PAUSED/COMPLETED/FAILED dulu, kemudian tekan APPLY CURRENT BATCH semula.'
          : result.reason === 'profile_missing'
            ? 'Format profile tak jumpa.'
            : 'Tak ada recaption batch terbaru yang boleh di-apply.';
        await telegram('sendMessage', { chat_id: chatId, text: reasonText });
        return true;
      }

      if (result.already_running) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: `♻️ APPLY CURRENT BATCH untuk ${result.profile?.name || 'format ini'} memang tengah berjalan. Aku biarkan worker sambung job yang sama.`,
        });
        return true;
      }

      if (!result.started) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: result.reason === 'no_matching_unsent_items'
            ? `✅ Tak ada item belum-SENT dalam batch terbaru yang matching ${result.profile?.name || 'format ini'}. Item SENT lama memang tak disentuh.`
            : 'Tak ada item yang perlu di-apply.',
        });
        return true;
      }

      await telegram('sendMessage', {
        chat_id: chatId,
        text: [
          `♻️ APPLY CURRENT BATCH start untuk ${result.profile.name}.`,
          `${result.matched} item matching yang belum SENT akan diproses semula dengan setting terbaru.`,
          result.unassigned
            ? `${result.unassigned} item belum ada format context; ia tak disentuh sekarang dan akan guna setting terbaru bila diproses nanti.`
            : 'Semua item batch yang berkaitan dah ada format context.',
          'Item yang dah SENT tak akan diubah.',
        ].join('\n'),
      });

      waitUntil(kickFormatBatchApply({
        sessionId: result.session.id,
        workerSecret: result.session.worker_secret,
        jobId: result.job.id,
      }).catch(async (error) => {
        console.error('Format batch apply initial kick failed:', error?.message || error);
        await telegram('sendMessage', {
          chat_id: chatId,
          text: `❌ APPLY CURRENT BATCH worker tak dapat start. Job masih disimpan; tekan button semula untuk retry. ${String(error?.message || error).slice(0, 220)}`,
        }).catch(() => {});
      }));
      return true;
    } catch (error) {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: `❌ APPLY CURRENT BATCH gagal start: ${String(error?.message || error).slice(0, 300)}`,
      });
      return true;
    }
  }

  const managerOption = formatManagerOptionFromAction(action);
  if (managerOption) {
    try {
      await toggleFormatOption(id, managerOption);
      await showFormatManager(id, chatId, message.message_id);
    } catch (error) {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: `Format tu tak boleh update: ${String(error?.message || error).slice(0, 250)}`,
      });
    }
    return true;
  }

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

  if (action === 'syncgroup') {
    const result = await syncSentItemById(id, { reason: 'button', mode: 'button' });
    await telegram('sendMessage', {
      chat_id: chatId,
      text: result.ok
        ? `✅ Caption group message ${result.destination_message_id} dah update.`
        : `❌ Group update gagal: ${String(result.error || result.reason || 'unknown').slice(0, 350)}`,
    });
    await showEditMenu(id, chatId, message.message_id).catch(() => {});
    return true;
  }

  if (action === 'syncmode') {
    const current = await getSentSyncMode();
    const next = await setSentSyncMode(current === 'auto' ? 'button' : 'auto');
    await telegram('sendMessage', {
      chat_id: chatId,
      text: next === 'auto'
        ? '⚡ AUTO UPDATE group ON. Edit item SENT akan sync ke group lepas edit settle.'
        : '🛡 AUTO UPDATE group OFF. Guna button UPDATE GROUP bila dah confirm edit.',
    });
    await showEditMenu(id, chatId, message.message_id).catch(() => {});
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

    if (action === 'fmt_confirm') {
      const result = await confirmFormatStep({ chatId, itemId: item.id });
      if (!result.ok) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Format review tu dah tak valid. Send item format baru sekali lagi kalau perlu.',
        });
        return true;
      }

      if (result.stage === 1) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Confirm sekali lagi kalau setting format ni memang betul. Lepas confirm kedua, guna /resume untuk sambung process.',
        });
      } else if (result.confirmed) {
        await reprocessItemWithProfile(item.id, result.profile || profile);
        await telegram('sendMessage', {
          chat_id: chatId,
          text: '✅ FORMAT CONFIRMED. Process dan SEND masih pause. Guna /resume bila dah ready sambung.',
        });
      }
      await keepFocus(item.id);
      await showEditMenu(item.id, chatId, message.message_id).catch(() => {});
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
