import { getSetting } from '../../store.js';
import { telegram } from '../../telegram.js';
import { isAdminMessage } from '../core/auth.js';
import { handleAgentText } from './agent-chat.js';
import { hasMedia, identifyMedia, prepareMedia } from './media.js';
import {
  collectForwardedQueueItem,
  isForwardedMessage,
} from './recaption-collection.js';
import { handleStateInput } from './state-input.js';

export async function handleFeatureMessage(message) {
  if (message?.chat?.type !== 'private') return false;
  if (!isAdminMessage(message)) return true;

  const state = await getSetting('admin_state');
  if (await handleStateInput({ message, state })) return true;
  if (hasMedia(message)) {
    if (isForwardedMessage(message)) {
      const collected = await collectForwardedQueueItem({
        message,
        media: identifyMedia(message),
      });

      // A Telegram webhook replay is intentionally silent. For a genuine new
      // collection, explain the new workflow only once, then stay out of the
      // way while the owner keeps forwarding.
      if (!collected.replay && Number(collected.session_count) === 1) {
        await telegram('sendMessage', {
          chat_id: message.chat.id,
          text: '📥 Collect mode aktif. Forward semua dulu — aku belum recaption apa-apa. Bila dah habis kumpul, hantar /recaption.',
          disable_notification: true,
        }).catch(() => {});
      } else if (!collected.replay && Number(collected.session_count) > 0 && Number(collected.session_count) % 20 === 0) {
        await telegram('sendMessage', {
          chat_id: message.chat.id,
          text: `📥 ${collected.session_count} item dah dikumpul. Aku masih tunggu /recaption.`,
          disable_notification: true,
        }).catch(() => {});
      }
      return true;
    }

    // Non-forwarded uploads keep the existing immediate-preview workflow.
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
