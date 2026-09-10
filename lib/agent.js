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

const SYSTEM = `You are Abang Render Coordinator, the owner's private Telegram AI assistant.

Act like a normal intelligent chat assistant that can also operate the owner's Telegram content workflow. The owner speaks casual Malay. Reply naturally in the same style.

Do not behave like a rigid command bot. Do not require special modes, keywords, buttons, or exact phrasing. Every normal owner message should receive a useful response. If the owner is unclear, ask one short clarification question instead of refusing or staying silent.

You can understand the current media item, recent conversation, file statistics, pending queue, saved memories, previous corrections and learned preferences supplied in context.

Available actions:
- chat: normal conversation, acknowledgement, explanation, follow-up, or answer from context.
- show_stats: answer questions about file totals, sent, pending, failed, progress or counts.
- show_pending: show items that are still pending/unsent.
- preview_item: owner wants to review or send the current item. The bot will show the preview with a SEND button; do not publish directly from natural language.
- revise_item: owner wants the current item cleaned, translated, renamed, reformatted, hashtags removed, serial/model retained, or title corrected. Put only the final product/model title in title. Never put the saved footer inside title.
- set_footer: owner wants to add, replace or change the reusable caption/footer shown below the title. Put only the exact desired footer content in footer_text, without the owner's instruction sentence.
- remember: owner explicitly asks you to remember/save a standing preference. Put the reusable preference in memory.
- skip_item: owner clearly asks to skip/remove the current item from the pending workflow.

Behavior:
- References such as "ni", "yang ni", "file ni", "tadi", "tajuk ni" usually refer to the focused/current item.
- If the owner corrects an item and the correction looks reusable, return a short learned preference in learn_rule. The bot saves it automatically so future items can benefit.
- Learning happens in the background. Do not force the owner into a special teaching mode.
- If the owner says things like "faham tak?", "halo", "ok ke?", or asks a follow-up, answer conversationally. Do not treat every message as a workflow action.
- If the owner says something like "tambah caption di bawah tajuk macam bawah ni" and then pastes text, use set_footer and extract only the pasted footer. Keep its wording and line breaks as closely as possible.
- If asked about totals, answer using the supplied statistics. Do not tell the owner to run a command.
- If asked to send/publish an item, choose preview_item. The final publish remains behind the SEND button to prevent accidental posting.
- If a format is unfamiliar or confidence is low, say so naturally and ask the owner how it should be handled, but still keep the conversation alive.
- Never expose secrets.
- Do not output Markdown symbols such as *, **, #, backticks, markdown tables, or code fences.
- Keep replies concise, clear and natural.

Return strict JSON only:
{"action":"chat|show_stats|show_pending|preview_item|revise_item|set_footer|remember|skip_item","reply":"natural reply","title":"","learn_rule":"","memory":"","footer_text":""}`;

export async function agentAssistant({ chatId, text, focusedItemId = null }) {
  const context = await loadContext(chatId, focusedItemId);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const fallback = fallbackPlan(text, context);
    await saveConversation(chatId, text, fallback.reply);
    return fallback;
  }

  const historyText = (context.history || [])
    .slice(-8)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Owner'}: ${String(m.content || '').slice(0, 900)}`)
    .join('\n');

  const prompt = `OWNER MESSAGE:\n${text}\n\nRECENT CHAT:\n${historyText || '(none)'}\n\nCURRENT CONTEXT:\n${context.contextText}`;
  const model = String(process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite').trim();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);
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
            temperature: 0.35,
            maxOutputTokens: 480,
            responseMimeType: 'application/json',
          },
        }),
      },
    ).finally(() => clearTimeout(timer));

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);

    const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('').trim();
    const parsed = parsePlan(raw);
    if (!parsed) throw new Error('Invalid AI response');

    await saveConversation(chatId, text, parsed.reply);
    return parsed;
  } catch (error) {
    console.error('Agent AI fallback:', error?.name === 'AbortError' ? 'timeout' : error?.message);
    const fallback = fallbackPlan(text, context);
    await saveConversation(chatId, text, fallback.reply);
    return fallback;
  }
}

async function loadContext(chatId, focusedItemId) {
  const [statsData, pending, memories, baseInstructions, learnedPreferences, footer, destination, history] = await Promise.all([
    stats(),
    listPending(8),
    listMemories(chatId, 20),
    getSetting('title_rules'),
    getSetting('learned_title_rules'),
    getSetting('caption_footer_html'),
    getSetting('destination_chat_id'),
    recentChatMessages(chatId, 10),
  ]);

  let item = null;
  if (focusedItemId) item = await getQueueItem(focusedItemId);
  if (!item) item = await getLatestQueueItem(chatId);

  const itemText = item
    ? `id=${item.id}\nstatus=${item.status}\nkind=${item.media_kind}\nfilename=${item.file_name || '(none)'}\nsource caption=${String(item.original_caption || '(none)').slice(0, 1800)}\ncurrent title=${item.generated_title || '(none)'}`
    : '(no current item)';

  const memoryText = memories?.length
    ? memories.map((m) => `- ${String(m.content || '').slice(0, 500)}`).join('\n')
    : '(none)';

  const learnedText = Array.isArray(learnedPreferences) && learnedPreferences.length
    ? learnedPreferences.slice(-20).map((r) => `- ${String(r).slice(0, 500)}`).join('\n')
    : '(none)';

  const pendingText = pending?.length
    ? pending.slice(0, 6).map((x, i) => `${i + 1}. ${x.status} | ${x.file_name || x.generated_title || 'Untitled'}`).join('\n')
    : '(none)';

  return {
    item,
    stats: statsData,
    pending,
    history,
    contextText: `CURRENT ITEM:\n${itemText}\n\nFILE STATS:\ntotal=${statsData.total}\nsent=${statsData.sent}\npending=${statsData.pending}\nfailed=${statsData.failed}\ncaptions_replaced=${statsData.caption_replaced}\n\nPENDING SAMPLE:\n${pendingText}\n\nOWNER BASE INSTRUCTIONS:\n${baseInstructions || '(default)'}\n\nLEARNED PREFERENCES FROM CORRECTIONS:\n${learnedText}\n\nLONG TERM MEMORY:\n${memoryText}\n\nCURRENT SAVED FOOTER:\n${footer || '(none)'}\n\nDESTINATION CONFIGURED=${Boolean(destination || process.env.DESTINATION_CHAT_ID)}`,
  };
}

function parsePlan(raw) {
  try {
    const cleaned = String(raw || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const data = JSON.parse(cleaned);
    const allowed = new Set(['chat', 'show_stats', 'show_pending', 'preview_item', 'revise_item', 'set_footer', 'remember', 'skip_item']);
    return {
      action: allowed.has(data.action) ? data.action : 'chat',
      reply: cleanText(data.reply || ''),
      title: cleanTitle(data.title || ''),
      learnRule: cleanText(data.learn_rule || '').slice(0, 500),
      memory: cleanText(data.memory || '').slice(0, 1500),
      footerText: cleanFooter(data.footer_text || ''),
    };
  } catch {
    return null;
  }
}

function fallbackPlan(text, context) {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();
  const item = context.item;

  const footerText = extractFooterCandidate(raw);
  if (footerText && /(caption|footer|bawah tajuk|bawah title|tambah|letak|add)/i.test(t)) {
    return {
      action: 'set_footer',
      reply: 'Faham. Aku jadikan bahagian tu sebagai caption bawah tajuk dan apply pada item sekarang.',
      title: '',
      learnRule: '',
      memory: '',
      footerText,
    };
  }

  if (/^(hi|hai|hello|helo|halo|hey|yo|boss)\b/i.test(raw)) {
    return plan('chat', item ? 'Ya boss, aku ada. Aku masih pegang item terbaru ni. Cakap je apa kau nak aku buat.' : 'Ya boss, aku ada. Cakap je apa kau nak buat atau nak tanya.');
  }

  if (/(faham tak|faham ke|understand|kau faham|jelas tak)/i.test(t)) {
    return plan('chat', item ? 'Faham. Aku masih ikut konteks item terbaru ni. Kau boleh terus cakap apa nak ubah tanpa format khas.' : 'Faham. Kau boleh sembang biasa je dengan aku, tak perlu ikut format command tertentu.');
  }

  if (/(berapa|jumlah|total|stat|statistics|progress)/i.test(t) && /(file|fail|sent|hantar|pending|failed|belum)/i.test(t)) {
    const s = context.stats;
    return plan('show_stats', `Sekarang ada ${s.total} file. ${s.sent} dah dihantar, ${s.pending} masih pending dan ${s.failed} failed.`);
  }

  if (/(apa.*pending|mana.*pending|belum hantar|tak hantar|unsent|senarai pending)/i.test(t)) {
    return plan('show_pending', 'Aku tunjuk yang masih pending.');
  }

  if (/(skip|abaikan|jangan proses|buang dari queue)/i.test(t) && item) {
    return plan('skip_item', 'Okay, item ni aku skip.');
  }

  if (/(send|hantar|publish|post)/i.test(t) && item) {
    return plan('preview_item', 'Okay, aku tunjuk preview item ni. Kalau dah betul, tekan SEND.');
  }

  if (item && /(buang|remove|delete|padam|ambil|keep|kekal|translate|terjemah|tajuk|title|hashtag|serial|siri|model|rename|tukar)/i.test(t)) {
    const title = localReviseTitle(item, t);
    return {
      action: 'revise_item',
      reply: 'Okay, aku cuba ikut arahan kau dan aku tunjuk preview baru.',
      title,
      learnRule: /(selalu|lepas ni|kalau format|setiap|jangan|kekalkan|buang hashtag)/i.test(t)
        ? cleanText(raw).slice(0, 500)
        : '',
      memory: '',
      footerText: '',
    };
  }

  return plan('chat', item
    ? 'Aku dengar. Aku masih pegang item terbaru ni, jadi kau boleh terus cakap apa nak ubah, tanya apa-apa, atau suruh aku tunjuk preview.'
    : 'Aku dengar. Cakap je macam chat biasa — aku boleh jawab, semak queue/statistik, ingat preference, dan urus file bila kau hantar.');
}

function extractFooterCandidate(text) {
  const value = String(text || '').trim();
  const markers = ['Tutorial Download:', 'More collection here'];
  let first = -1;
  for (const marker of markers) {
    const i = value.toLowerCase().indexOf(marker.toLowerCase());
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  if (first >= 0) return value.slice(first).trim();

  const parts = value.split(/\n\s*\n/);
  if (parts.length > 1 && /(caption|footer|bawah tajuk|bawah title|macam bawah)/i.test(parts[0])) {
    return parts.slice(1).join('\n\n').trim();
  }
  return '';
}

function localReviseTitle(item, instruction) {
  const source = String(item.original_caption || item.generated_title || item.file_name || '');
  let lines = source
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !/^(?:tutorial download|more collection here)/i.test(x));

  if (/(hashtag|#)/i.test(instruction) && /(buang|remove|delete|padam|jangan)/i.test(instruction)) {
    lines = lines.filter((x) => !x.startsWith('#'));
  }

  if (/(tajuk|title|serial|siri|model)/i.test(instruction)) {
    lines = lines.filter((x) => !x.startsWith('#')).slice(0, 2);
  }

  const result = lines.slice(0, 2).join('\n').trim();
  return cleanTitle(result || item.generated_title || item.file_name || 'Untitled');
}

function plan(action, reply) {
  return { action, reply, title: '', learnRule: '', memory: '', footerText: '' };
}

async function saveConversation(chatId, userText, assistantText) {
  await Promise.allSettled([
    saveChatMessage(chatId, 'user', userText),
    saveChatMessage(chatId, 'assistant', assistantText || ''),
  ]);
}

function cleanTitle(value) {
  return cleanText(value)
    .split(/\n\s*(?:Tutorial Download|More collection here)\s*:?/i)[0]
    .trim()
    .slice(0, 180);
}

function cleanFooter(value) {
  return String(value || '')
    .replace(/```[a-z0-9_-]*\n?/gi, '')
    .replace(/```/g, '')
    .trim()
    .slice(0, 3000);
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
