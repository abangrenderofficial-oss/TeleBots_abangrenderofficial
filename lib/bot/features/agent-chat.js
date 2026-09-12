import { agentAssistant } from '../../agent.js';
import { telegram, inlineKeyboard } from '../../telegram.js';
import { addMemory, getSetting, setSetting } from '../../store.js';
import { keepFocus } from './context.js';
import { sendPreview } from './preview-ui.js';
import { maybeSyncSentItem } from './sent-sync.js';

const SENT_EDIT_TOOLS = new Set([
  'update_title',
  'update_caption',
  'append_caption',
  'set_footer',
  'apply_footer',
  'remove_hashtags',
  'translate_title',
  'clean_title',
  'extract_title',
  'learn_format_from_correction',
  'undo_last_change',
]);

export async function handleAgentText({ chatId, message, state }) {
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

  // Sync once after the whole agent turn, not once per internal tool. This
  // avoids racing several intermediate captions into the destination group.
  if (
    result.focusedItemId
    && (result.toolsUsed || []).some((name) => SENT_EDIT_TOOLS.has(name))
  ) {
    await maybeSyncSentItem(result.focusedItemId, { reason: 'agent_edit' }).catch((error) => {
      console.error('Agent sent-caption sync failed:', error?.message || error);
    });
  }

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
  for (const bubble of splitIntoBubbles(text)) {
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
