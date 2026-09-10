import {
  getLatestQueueItem,
  getQueueItem,
  getSetting,
  listMemories,
  listPending,
  recentChatMessages,
  saveChatMessage,
  stats,
} from './store.js';

const SYSTEM = `You are Abang Render Coordinator, a private AI agent inside the owner's Telegram bot.

The owner speaks casual Malay and wants to use the bot by chatting naturally, not by memorizing commands or rigid rules.

Your job is to understand what the owner means, answer naturally, and choose an action when the bot can do useful work.

Available actions:
- chat: normal conversation or answer a question from the supplied context.
- show_stats: owner asks about total files, sent, pending, failed, counts, progress, or statistics.
- show_pending: owner asks what is still pending / unsent or wants the pending list.
- preview_item: owner wants to see/review/prepare the current item before sending. Never publish directly from natural language; show preview with SEND button instead.
- revise_item: owner wants the current/selected media title changed, cleaned, translated, reformatted, hashtags removed, serial/model retained, or otherwise corrected. Return the final title only in title. Footer is added by the bot automatically and must never be put inside title.
- remember: owner explicitly asks you to remember/save a preference or standing instruction. Return the reusable memory in memory.

Important:
- Be flexible. Do not refuse just because the owner's wording does not match a command.
- If there is a focused item, references like "ni", "yang ni", "file ni", "tajuk ni" refer to that focused item. Otherwise use the latest queue item.
- If FOCUS MODE is EDIT or TEACH, treat the owner's next normal message as being about that focused item unless the message clearly changes topic.
- For revise_item, infer the best corrected title from source caption, filename, current title, owner message, saved rules and memories.
- If the owner teaches a reusable title preference while revising, put a short reusable rule in learn_rule. Example: "Remove hashtag lines and keep serial/model code plus product title." Do not include the footer in learn_rule.
- If FOCUS MODE is TEACH and the owner gives a correction, usually include learn_rule so future items benefit automatically.
- If the owner merely chats or asks general questions, use chat.
- You may answer file totals directly using the supplied stats; do not tell the owner to run /stats.
- If the owner asks to send/publish, choose preview_item and explain that the SEND button is ready. Do not directly publish from natural language.
- Never expose secrets.
- Do not output Markdown symbols such as *, **, #, backticks, markdown tables, or code fences.
- Keep replies concise and natural.

Return strict JSON only:
{"action":"chat|show_stats|show_pending|preview_item|revise_item|remember","reply":"natural reply","title":"","learn_rule":"","memory":""}`;

export async function agentAssistant({ chatId, text, focusedItemId = null, focusMode = null }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const context = await loadContext(chatId, focusedItemId, focusMode);

  if (!apiKey) return fallbackPlan(text, context);

  const historyText = (context.history || [])
    .slice(-10)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Owner'}: ${String(m.content || '').slice(0, 1200)}`)
    .join('\n');

  const prompt = `OWNER MESSAGE:\n${text}\n\nRECENT CHAT:\n${historyText || '(none)'}\n\nCURRENT CONTEXT:\n${context.contextText}`;

  const preferred = String(process.env.GEMINI_MODEL || '').trim();
  const models = [...new Set([
    preferred,
    'gemini-2.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
  ].filter(Boolean))];

  let lastError = '';
  for (const model of models) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
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
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.25,
              maxOutputTokens: 500,
              responseMimeType: 'application/json',
            },
          }),
        },
      ).finally(() => clearTimeout(timer));

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = `${model}: ${data?.error?.message || `HTTP ${response.status}`}`;
        continue;
      }

      const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('').trim();
      const parsed = parsePlan(raw);
      if (parsed) {
        await saveConversation(chatId, text, parsed.reply);
        return parsed;
      }
      lastError = `${model}: invalid JSON`;
    } catch (error) {
      lastError = `${model}: ${error?.name === 'AbortError' ? 'request timeout' : (error?.message || 'request failed')}`;
    }
  }

  const fallback = fallbackPlan(text, context);
  if (!fallback.reply) fallback.reply = `Aku faham mesej kau, tapi AI tengah lambat sekejap. Cuba sekali lagi. (${safeError(lastError)})`;
  await saveConversation(chatId, text, fallback.reply);
  return fallback;
}

async function loadContext(chatId, focusedItemId, focusMode) {
  const [statsData, pending, memories, rules, learnedRules, footer, destination, history] = await Promise.all([
    stats(),
    listPending(12),
    listMemories(chatId, 30),
    getSetting('title_rules'),
    getSetting('learned_title_rules'),
    getSetting('caption_footer_html'),
    getSetting('destination_chat_id'),
    recentChatMessages(chatId, 12),
  ]);

  let item = null;
  if (focusedItemId) item = await getQueueItem(focusedItemId);
  if (!item) item = await getLatestQueueItem(chatId);

  const itemText = item
    ? `id=${item.id}\nstatus=${item.status}\nkind=${item.media_kind}\nfilename=${item.file_name || '(none)'}\nsource caption=${item.original_caption || '(none)'}\ncurrent title=${item.generated_title || '(none)'}`
    : '(no current item)';

  const memoryText = memories?.length ? memories.map((m) => `- ${m.content}`).join('\n') : '(none)';
  const learnedText = Array.isArray(learnedRules) && learnedRules.length ? learnedRules.map((r) => `- ${r}`).join('\n') : '(none)';

  return {
    item,
    stats: statsData,
    pending,
    history,
    focusMode,
    contextText: `FOCUS MODE=${focusMode || 'NONE'}\n\nCURRENT ITEM:\n${itemText}\n\nFILE STATS:\ntotal=${statsData.total}\nsent=${statsData.sent}\npending=${statsData.pending}\nfailed=${statsData.failed}\ncaptions_replaced=${statsData.caption_replaced}\n\nPENDING ITEMS COUNT=${pending?.length || 0}\n\nSAVED TITLE RULES:\n${rules || '(default rules)'}\n\nLEARNED TITLE RULES:\n${learnedText}\n\nLONG TERM MEMORY:\n${memoryText}\n\nFOOTER CONFIGURED=${Boolean(footer)}\nDESTINATION CONFIGURED=${Boolean(destination || process.env.DESTINATION_CHAT_ID)}`,
  };
}

function parsePlan(raw) {
  try {
    const data = JSON.parse(String(raw || '').trim());
    const allowed = new Set(['chat', 'show_stats', 'show_pending', 'preview_item', 'revise_item', 'remember']);
    return {
      action: allowed.has(data.action) ? data.action : 'chat',
      reply: cleanText(data.reply || ''),
      title: cleanTitle(data.title || ''),
      learnRule: cleanText(data.learn_rule || '').slice(0, 500),
      memory: cleanText(data.memory || '').slice(0, 1500),
    };
  } catch {
    return null;
  }
}

function fallbackPlan(text, context) {
  const t = String(text || '').toLowerCase();
  if (context.focusMode && context.item && /(buang|remove|delete|padam|ambil|keep|kekal|translate|terjemah|tajuk|title|hashtag|serial|siri|model|caption)/i.test(t)) {
    const source = String(context.item.original_caption || context.item.generated_title || context.item.file_name || '');
    const title = source.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).filter((x) => !x.startsWith('#')).slice(0, 2).join('\n').slice(0, 180);
    return {
      action: 'revise_item',
      reply: 'Aku dah cuba kemaskan item ni ikut arahan kau. Aku tunjuk preview baru.',
      title,
      learnRule: context.focusMode === 'TEACH' ? 'Follow owner corrections while excluding hashtag lines and footer text from titles.' : '',
      memory: '',
    };
  }
  if (/\b(total|berapa|stat|jumlah|file|fail)\b/.test(t) && /\b(total|berapa|stat|jumlah|sent|pending|failed|hantar|belum)\b/.test(t)) {
    const s = context.stats;
    return { action: 'show_stats', reply: `Sekarang ada ${s.total} file. ${s.sent} dah dihantar, ${s.pending} masih pending dan ${s.failed} failed.`, title: '', learnRule: '', memory: '' };
  }
  if (/\b(pending|belum hantar|tak hantar|unsent)\b/.test(t)) return { action: 'show_pending', reply: 'Aku tunjuk item yang masih pending.', title: '', learnRule: '', memory: '' };
  if (/\b(send|hantar|publish|post)\b/.test(t) && context.item) return { action: 'preview_item', reply: 'Aku sediakan preview item ni. Kalau dah okay, tekan SEND.', title: '', learnRule: '', memory: '' };
  return { action: 'chat', reply: 'Aku faham. Cakap je apa yang kau nak aku buat dengan item atau workflow ni.', title: '', learnRule: '', memory: '' };
}

async function saveConversation(chatId, userText, assistantText) {
  await Promise.allSettled([
    saveChatMessage(chatId, 'user', userText),
    saveChatMessage(chatId, 'assistant', assistantText || ''),
  ]);
}

function cleanTitle(value) {
  return cleanText(value).split(/\n\s*(?:Tutorial Download|More collection here)\s*:?/i)[0].trim().slice(0, 180);
}

function cleanText(value) {
  return String(value || '')
    .replace(/```[a-z0-9_-]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeError(value) {
  return String(value || 'Unknown error')
    .replace(/AIza[0-9A-Za-z_-]+/g, '[API_KEY_HIDDEN]')
    .replace(/eyJ[0-9A-Za-z._-]+/g, '[TOKEN_HIDDEN]')
    .slice(0, 180);
}
