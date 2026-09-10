import {
  getSetting,
  listMemories,
  listPending,
  recentChatMessages,
  saveChatMessage,
  stats,
} from './store.js';

const BASE_SYSTEM = `You are Abang Render Coordinator, the private AI assistant inside the owner's Telegram bot.

Your job is to help the owner operate this bot and its Telegram content workflow. You are conversational, practical and concise. The owner commonly speaks informal Malay; reply in the same language/style unless they clearly use another language.

You know this bot can:
- receive documents, photos, videos, animations and audio in private chat
- use Gemini to extract a clean product/model title from a source caption or filename
- translate foreign-language titles to English while preserving brand names, model numbers, product codes and software/version names
- build a final caption using the generated title plus the owner's saved footer
- preview media before sending
- edit a title, teach a corrected title, skip an item, show pending items and send items to a configured destination
- keep queue/history in Supabase
- count document/file statistics while excluding photos from the primary file total
- save title rules and teaching examples

Important behavior:
- Never claim you sent, changed, deleted or configured something unless the bot actually performed that action.
- Never reveal or ask the owner to paste secrets such as bot tokens, service-role keys, Gemini keys or setup secrets into chat.
- If the owner asks how to do something, explain the exact bot command/button/workflow that exists.
- Long-term memories supplied below are trusted owner preferences/instructions.
- Recent conversation history is context, not a permanent rule.
- If a requested capability does not exist yet, say it is not implemented yet instead of pretending.
- Keep answers compact unless the owner asks for detail.
- Write like a normal polished chat assistant. Do NOT output Markdown formatting symbols such as *, **, _, #, backticks or markdown tables.
- Use natural paragraphs. When a list is useful, use simple numbered lines or the bullet character •. Do not surround words with formatting markers.`;

export async function chatAssistant({ chatId, text }) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return '⚠️ Gemini belum configured untuk AI chat.';

    const context = await loadContext(chatId);
    const contents = buildContents(context.history, text);

    // Prefer the low-latency Flash-Lite model for Telegram chat.
    const preferred = String(process.env.GEMINI_MODEL || '').trim();
    const models = [...new Set([preferred, 'gemini-3.1-flash-lite', 'gemini-3.5-flash'].filter(Boolean))];

    let lastError = null;
    let clean = '';

    for (const model of models) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'x-goog-api-key': apiKey,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: `${BASE_SYSTEM}${context.runtimeContext}` }] },
              contents,
              generationConfig: {
                maxOutputTokens: 600,
                responseMimeType: 'text/plain',
                thinkingConfig: { thinkingLevel: 'minimal' },
              },
            }),
          },
        ).finally(() => clearTimeout(timer));

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          lastError = `${model}: ${data?.error?.message || `HTTP ${response.status}`}`;
          continue;
        }

        const answer = data?.candidates?.[0]?.content?.parts
          ?.map((part) => part?.text || '')
          .join('')
          .trim();

        clean = cleanChatText(answer).slice(0, 3900);
        if (clean) break;
        lastError = `${model}: empty response`;
      } catch (error) {
        lastError = `${model}: ${error?.name === 'AbortError' ? 'request timeout' : (error?.message || 'request failed')}`;
      }
    }

    if (!clean) {
      console.error('AI chat models failed:', lastError);
      return `⚠️ Gemini AI tak berjaya jawab. ${safeError(lastError)}\n\nCuba /aitest untuk check sambungan Gemini.`;
    }

    await Promise.allSettled([
      saveChatMessage(chatId, 'user', text),
      saveChatMessage(chatId, 'assistant', clean),
    ]);

    return clean;
  } catch (error) {
    console.error('AI chat error:', error);
    return `⚠️ AI chat ada error: ${safeError(error?.message)}\n\nCuba /aitest untuk check sambungan Gemini.`;
  }
}

export async function testGeminiConnection() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY missing' };

  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const models = [...new Set([preferred, 'gemini-3.1-flash-lite', 'gemini-3.5-flash'].filter(Boolean))];
  const attempts = [];

  for (const model of models) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-goog-api-key': apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply only with OK' }] }],
            generationConfig: {
              maxOutputTokens: 30,
              responseMimeType: 'text/plain',
              thinkingConfig: { thinkingLevel: 'minimal' },
            },
          }),
        },
      ).finally(() => clearTimeout(timer));

      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const answer = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('').trim();
        return { ok: true, model, ms: Date.now() - started, answer: answer || '(empty)' };
      }

      attempts.push({ model, ms: Date.now() - started, error: safeError(data?.error?.message || `HTTP ${response.status}`) });
    } catch (error) {
      attempts.push({
        model,
        ms: Date.now() - started,
        error: error?.name === 'AbortError' ? 'request timeout' : safeError(error?.message),
      });
    }
  }

  return { ok: false, attempts };
}

async function loadContext(chatId) {
  const [memories, history, titleRules, footer, destination, fileStats, pending] = await Promise.all([
    listMemories(chatId, 40),
    recentChatMessages(chatId, 16),
    getSetting('title_rules'),
    getSetting('caption_footer_html'),
    getSetting('destination_chat_id'),
    stats(),
    listPending(10),
  ]);

  const memoryText = memories?.length
    ? memories.map((m) => `#${m.id}: ${m.content}`).join('\n')
    : '(none yet)';

  const pendingText = pending?.length
    ? pending.map((x, i) => `${i + 1}. ${x.status} | ${x.media_kind} | ${x.file_name || x.generated_title || 'Untitled'}`).join('\n')
    : '(none)';

  const runtimeContext = `\n\nCURRENT BOT CONTEXT\nLong-term memories:\n${memoryText}\n\nTitle rules:\n${titleRules || '(default title rules are being used)'}\n\nFooter configured: ${Boolean(footer)}\nDestination configured: ${Boolean(destination || process.env.DESTINATION_CHAT_ID)}\nDocument stats: total=${fileStats.total}, sent=${fileStats.sent}, pending=${fileStats.pending}, failed=${fileStats.failed}, captions_replaced=${fileStats.caption_replaced}\n\nCurrent queue sample:\n${pendingText}`;

  return { history, runtimeContext };
}

function buildContents(history, text) {
  const contents = [];
  for (const message of history || []) {
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content || '').slice(0, 5000) }],
    });
  }
  contents.push({ role: 'user', parts: [{ text }] });
  return contents;
}

function cleanChatText(value) {
  return String(value || '')
    .replace(/```[a-z0-9_-]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeError(value) {
  const text = String(value || 'Unknown error');
  return text
    .replace(/AIza[0-9A-Za-z_-]+/g, '[API_KEY_HIDDEN]')
    .replace(/eyJ[0-9A-Za-z._-]+/g, '[TOKEN_HIDDEN]')
    .slice(0, 500);
}
