import { getSetting } from '../../store.js';
import { isAdminMessage } from '../core/auth.js';
import { handleAgentText } from './agent-chat.js';
import { hasMedia, prepareMedia } from './media.js';
import { handleStateInput } from './state-input.js';

export async function handleFeatureMessage(message) {
  if (message?.chat?.type !== 'private') return false;
  if (!isAdminMessage(message)) return true;

  const state = await getSetting('admin_state');
  if (await handleStateInput({ message, state })) return true;
  if (hasMedia(message)) {
    await prepareMedia(message);
    return true;
  }

  const text = message.text?.trim();
  if (text) {
    await handleAgentText({ chatId: message.chat.id, message, state });
    return true;
  }

  return false;
}
