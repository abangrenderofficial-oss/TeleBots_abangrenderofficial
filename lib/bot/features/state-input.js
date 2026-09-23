import { buildCaption } from '../../caption.js';
import { telegramTextToHtml } from '../../entities.js';
import {
  getFormatProfile,
  setFormatFooter,
} from '../../format-profiles.js';
import {
  addFormatRemoveTerms,
  clearFormatRemoveTerms,
} from '../../remove-words.js';
import {
  getLatestQueueItem,
  getQueueItem,
  setSetting,
  updateQueueItem,
} from '../../store.js';
import { telegram } from '../../telegram.js';
import { deleteHelperPrompt, keepFocus } from './context.js';
import { showFormatManager } from './format-manager.js';
import { markFormatProfileChanged } from './pipeline-controller.js';
import { reprocessItemWithProfile, sendPreview, showEditMenu } from './preview-ui.js';
import { maybeSyncSentItem } from './sent-sync.js';

export async function handleStateInput({ message, state }) {
  const text = message.text?.trim();
  if (!state || !text) return false;

  const chatId = message.chat.id;

  if (state.mode === 'EDIT_MANAGED_FORMAT_REMOVE_WORDS') {
    const profile = await getFormatProfile(state.profile_id);
    if (!profile) {
      await setSetting('admin_state', null);
      await telegram('sendMessage', { chat_id: chatId, text: 'Format tu dah tak jumpa. Buka /formats semula.' });
      return true;
    }

    if (/^(?:clear|reset|padam semua|buang semua)$/i.test(text)) {
      await clearFormatRemoveTerms(profile.id);
    } else {
      await addFormatRemoveTerms(profile.id, text);
    }
    await markFormatProfileChanged({ chatId, profileId: profile.id });

    await setSetting('admin_state', null);
    await deleteHelperPrompt(chatId, state.prompt_message_id);
    await showFormatManager(profile.id, chatId, state.manager_message_id).catch(() => {});
    return true;
  }

  if (state.mode === 'EDIT_MANAGED_FORMAT_FOOTER') {
    const profile = await getFormatProfile(state.profile_id);
    if (!profile) {
      await setSetting('admin_state', null);
      await telegram('sendMessage', { chat_id: chatId, text: 'Format tu dah tak jumpa. Buka /formats semula.' });
      return true;
    }

    const clear = /^(?:clear|reset|kosong|padam)$/i.test(text);
    const html = clear ? '' : telegramTextToHtml(message.text, message.entities || []);
    await setFormatFooter(profile.id, html);
    await markFormatProfileChanged({ chatId, profileId: profile.id });
    await setSetting('admin_state', null);
    await deleteHelperPrompt(chatId, state.prompt_message_id);
    await showFormatManager(profile.id, chatId, state.manager_message_id).catch(() => {});
    return true;
  }

  if (state.mode === 'ADD_FORMAT_REMOVE_WORDS') {
    const item = await getQueueItem(state.item_id);
    const profile = await getFormatProfile(state.profile_id);
    if (!item || !profile) {
      await setSetting('admin_state', null);
      await telegram('sendMessage', { chat_id: chatId, text: 'Item atau format tu dah tak jumpa.' });
      return true;
    }

    if (/^(?:clear|reset|padam semua|buang semua)$/i.test(text)) {
      await clearFormatRemoveTerms(profile.id);
    } else {
      await addFormatRemoveTerms(profile.id, text);
    }
    await markFormatProfileChanged({ chatId, profileId: profile.id });

    await reprocessItemWithProfile(item.id, profile);
    await keepFocus(item.id);
    await deleteHelperPrompt(chatId, state.prompt_message_id);
    await showEditMenu(item.id, chatId);
    return true;
  }

  if (state.mode === 'EDIT_FORMAT_FOOTER') {
    const item = await getQueueItem(state.item_id);
    const profile = await getFormatProfile(state.profile_id);
    if (!item || !profile) {
      await setSetting('admin_state', null);
      await telegram('sendMessage', { chat_id: chatId, text: 'Item atau format tu dah tak jumpa. Send file balik jap.' });
      return true;
    }

    const html = telegramTextToHtml(message.text, message.entities || []);
    const updatedProfile = await setFormatFooter(profile.id, html);
    await markFormatProfileChanged({ chatId, profileId: profile.id });
    await reprocessItemWithProfile(item.id, updatedProfile);
    await keepFocus(item.id);
    await deleteHelperPrompt(chatId, state.prompt_message_id);
    await showEditMenu(item.id, chatId);
    return true;
  }

  if (state.mode === 'SET_CAPTION') {
    const html = telegramTextToHtml(message.text, message.entities || []);
    await setSetting('caption_footer_html', html);
    const item = state?.item_id
      ? await getQueueItem(state.item_id)
      : await getLatestQueueItem(chatId);

    if (item) {
      const finalCaption = await buildCaption(item.generated_title || 'Untitled');
      const updated = await updateQueueItem(item.id, {
        final_caption_html: finalCaption,
        caption_replaced: true,
      });
      await maybeSyncSentItem(updated, { reason: 'set_caption' });
      await keepFocus(item.id);
      await sendPreview(item.id, chatId);
      return true;
    }

    await setSetting('admin_state', null);
    await telegram('sendMessage', { chat_id: chatId, text: 'Okay, caption global dah simpan.' });
    return true;
  }

  return false;
}
