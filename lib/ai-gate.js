import { getSetting, setSetting, updateQueueItem } from './store.js';
import { telegram, inlineKeyboard } from './telegram.js';
import { setRecaptionSessionStatus } from './bot/features/recaption-collection.js';

const BYPASS_PREFIX = 'recaption_ai_bypass_v1:';
const WAIT_PREFIX = 'recaption_ai_wait_v1:';

export function hasNonLatinSourceScript(value) {
  return /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0e00-\u0e7f]/u.test(String(value || ''));
}

export function titleNeedsTranslation(processed) {
  const serial = String(processed?.serial || '').trim();
  const fullTitle = String(processed?.title || '').trim();
  if (!fullTitle) return false;

  let coreTitle = fullTitle;
  if (serial) {
    const lines = fullTitle.split(/\r?\n/);
    if (String(lines[0] || '').trim().toLowerCase() === serial.toLowerCase()) {
      coreTitle = lines.slice(1).join('\n').trim();
    }
  }
  return Boolean(coreTitle && hasNonLatinSourceScript(coreTitle));
}

export function isAiUnavailableError(error) {
  return /(?:translation unavailable|vision unavailable|all ai providers unavailable)/i.test(String(error?.message || error || ''));
}

export async function isRecaptionAiBypass(sessionId) {
  if (!sessionId) return false;
  const value = await getSetting(`${BYPASS_PREFIX}${sessionId}`).catch(() => null);
  return Boolean(value?.enabled);
}

export async function setRecaptionAiBypass(sessionId, enabled = true) {
  if (!sessionId) return null;
  return setSetting(`${BYPASS_PREFIX}${sessionId}`, {
    enabled: Boolean(enabled),
    updated_at: new Date().toISOString(),
  });
}

export async function getRecaptionAiWait(sessionId) {
  if (!sessionId) return null;
  return getSetting(`${WAIT_PREFIX}${sessionId}`).catch(() => null);
}

export async function clearRecaptionAiState(sessionId) {
  if (!sessionId) return;
  await Promise.all([
    setSetting(`${WAIT_PREFIX}${sessionId}`, null).catch(() => {}),
    setSetting(`${BYPASS_PREFIX}${sessionId}`, null).catch(() => {}),
  ]);
}

export async function pauseRecaptionForAi({ sessionId, chatId, itemId, kind = 'ai', error }) {
  if (!sessionId || !chatId) return null;

  const key = `${WAIT_PREFIX}${sessionId}`;
  const existing = await getSetting(key).catch(() => null);
  const message = String(error?.message || error || 'AI unavailable').slice(0, 700);
  const wait = {
    paused: true,
    session_id: String(sessionId),
    item_id: itemId ? String(itemId) : null,
    kind,
    error: message,
    at: new Date().toISOString(),
  };

  await setSetting(key, wait);
  if (itemId) {
    await updateQueueItem(itemId, {
      status: 'PENDING',
      error_message: `AI_WAIT: ${message}`,
    }).catch(() => {});
  }
  await setRecaptionSessionStatus(sessionId, 'PAUSED').catch(() => {});

  if (!existing?.paused) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: [
        '⚠️ AI yang diperlukan untuk batch ni tak available / limit dah habis buat masa sekarang.',
        kind === 'vision'
          ? 'Ada gambar yang memang tak ada tajuk, jadi AI vision diperlukan untuk cipta tajuk.'
          : 'Ada tajuk yang memang perlukan translation AI.',
        '',
        'Item yang tak perlukan AI tak akan guna quota AI. Kalau kau nak teruskan batch tanpa AI untuk item yang memerlukannya, tekan button bawah.',
      ].join('\n'),
      reply_markup: inlineKeyboard([[
        { text: '▶️ TERUSKAN TANPA AI', callback_data: `ai_continue:${sessionId}` },
      ]]),
    }).catch(() => {});
  }

  return wait;
}
