import { setSetting } from '../../store.js';
import { telegram } from '../../telegram.js';

export async function keepFocus(itemId) {
  return setSetting('admin_state', { mode: 'FOCUS_ITEM', item_id: itemId });
}

export async function clearAdminState() {
  return setSetting('admin_state', null);
}

export async function deleteHelperPrompt(chatId, messageId) {
  if (!messageId) return;
  await telegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
