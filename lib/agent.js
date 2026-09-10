import {
  getLatestAnyQueueItem,
  getLatestQueueItem,
  getQueueItem,
  getSetting,
  listMemories,
  recentChatMessages,
  saveChatMessage,
} from './store.js';
import {
  executeAgentTool,
  getInitialToolDeclarations,
  getToolDeclarations,
} from './tool-registry.js';

const SYSTEM = `You are Abang Render Coordinator, the owner's private Telegram AI worker.

You are not a command bot. Talk naturally in casual Malay like the owner. The owner should be able to say anything in normal conversation and you decide whether to just reply or use tools to do real work.

You have a modular toolbox. Start with a small set of tools. If you need another capability, call discover_tools with a short description of what you need. After discovery, the newly discovered tools will be made available to you on the next turn. You may call multiple tools in sequence until the task is actually complete.

Important operating rules:
- For current workflow facts such as totals, queue status, last sent item, current caption, destination, duplicates, or memories, use tools. Never guess database state.
- For edits, use tools to actually change data. Do not merely say you changed something.
- If the owner gives several instructions in one message, perform all reasonable steps in sequence.
- References like "ni", "yang ni", "tadi", "file ni", "last tadi" normally refer to the focused/current item or recent conversation.
- Learning is automatic/background. There is no special EDIT or AJAR AI mode.
- If the owner corrects a reusable format, save a learning example/rule after making the correction.
- A sentence such as "lepas kau dah ambil tajuk, kau kena ambil no siri juga" is an edit instruction, not casual chat. Read the current item's original caption, preserve the serial/model/product code, combine it with the current product title, update the item, learn that preference, and let the Telegram layer preview the corrected result.
- If the owner asks you to remember a lasting preference, use save_memory.
- When the owner asks to send/publish, use send_item. It deliberately returns a preview confirmation instead of publishing directly.
- Bulk send also requires confirmation.
- Internal edits, search, statistics, memory, learning, preview, skip, and undo can be performed directly when the intent is clear.
- If a request is unclear, ask one short clarification question. Do not invent a rigid format for the owner to follow.
- Never expose API keys, tokens, service-role keys, or secrets.
- Do not output Markdown symbols like asterisks, headings, backticks, tables, or code fences in Telegram replies.
- Keep the final reply concise and say what you actually did or found.

You can converse normally without calling any tool when no real action/data lookup is needed.`;

const MUTATING_ITEM_TOOLS = new Set([
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

export async function agentAssistant({
  chatId,
  text,
  focusedItemId = null,
  ownerText = '',
  ownerEntities = [],
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const runtime = {
    chatId,
    focusedItemId,
    ownerText: ownerText || text || '',
    ownerEntities: Array.isArray(ownerEntities) ? ownerEntities : [],
  };

  const context = await loadLightContext(chatId, focusedItemId);
  if (!apiKey) return fallbackAssistant(text, runtime, context);

  const historyText = (context.history || [])
    .slice(-8)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Owner'}: ${String(m.content || '').slice(0, 900)}`)
    .join('\n');

  const prompt = `OWNER MESSAGE:\n${text}\n\nRECENT CHAT:\n${historyText || '(none)'}\n\nLIGHT CONTEXT:\n${context.contextText}`;
  const contents = [{ role: 'user', parts: [{ text: prompt }] }];

  const declarationMap = new Map();
  for (const declaration of getInitialToolDeclarations()) declarationMap.set(declaration.name, declaration);

  const effects = [];
  const toolTrace = [];
  let finalReply = '';
  let activeModel = '';

  try {
    for (let round = 0; round < 6; round += 1) {
      const response = await callGemini({
        apiKey,
        contents,
        declarations: [...declarationMap.values()],
        modelHint: activeModel,
      });
      activeModel = response.model;
      const data = response.data;

      const candidate = data?.candidates?.[0]?.content;
      const parts = candidate?.parts || [];
      const calls = parts.map((part) => part?.functionCall).filter(Boolean);

      if (!calls.length) {
        finalReply = cleanText(parts.map((part) => part?.text || '').join('').trim());
        if (!finalReply && !toolTrace.length) {
          throw new Error(`AI returned no text or tool call (${data?.candidates?.[0]?.finishReason || 'unknown finish'})`);
        }
        break;
      }

      contents.push(candidate);
      const functionResponses = [];

      for (const call of calls) {
        const name = String(call.name || '');
        const args = call.args && typeof call.args === 'object' ? call.args : {};
        const result = await executeAgentTool(name, args, runtime);
        toolTrace.push({ name, args: sanitizeArgs(args), ok: result?.ok !== false });

        if (name === 'discover_tools' && Array.isArray(result?.tools)) {
          const names = result.tools.map((tool) => tool.name);
          for (const declaration of getToolDeclarations(names)) {
            declarationMap.set(declaration.name, declaration);
          }
        }

        collectEffects(result, effects);

        const functionResponse = {
          name,
          response: safeToolResponse(result),
        };
        if (call.id) functionResponse.id = call.id;
        functionResponses.push({ functionResponse });
      }

      contents.push({ role: 'user', parts: functionResponses });
    }
  } catch (error) {
    console.error('Agent tool loop failed:', error?.name === 'AbortError' ? 'timeout' : error?.message);
    return fallbackAssistant(text, runtime, context, error);
  }

  if (!finalReply) {
    finalReply = toolTrace.length
      ? 'Okay, aku dah buat perubahan yang kau minta.'
      : 'Ya, aku dengar. Cakap je macam biasa.';
  }

  autoPreviewAfterEdits(toolTrace, runtime, effects);
  const result = {
    reply: finalReply,
    effects: dedupeEffects(effects),
    toolsUsed: toolTrace.map((x) => x.name),
    focusedItemId: runtime.focusedItemId || focusedItemId || null,
  };

  await saveConversation(chatId, text, result.reply);
  return result;
}

async function callGemini({ apiKey, contents, declarations, modelHint = '' }) {
  const agentPreferred = String(process.env.GEMINI_AGENT_MODEL || '').trim();
  const generalPreferred = String(process.env.GEMINI_MODEL || '').trim();
  const models = [...new Set([
    modelHint,
    agentPreferred,
    generalPreferred,
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
  ].filter(Boolean))];

  const started = Date.now();
  const totalBudgetMs = 12000;
  const errors = [];

  for (const model of models) {
    const remaining = totalBudgetMs - (Date.now() - started);
    if (remaining < 1800) break;
    const timeoutMs = Math.min(6000, remaining);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

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
            contents,
            tools: [{ functionDeclarations: declarations }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 520,
            },
          }),
        },
      ).finally(() => clearTimeout(timer));

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        errors.push(`${model}: ${safeError(data?.error?.message || `HTTP ${response.status}`)}`);
        continue;
      }
      return { data, model };
    } catch (error) {
      errors.push(`${model}: ${error?.name === 'AbortError' ? 'timeout' : safeError(error?.message || 'request failed')}`);
    }
  }

  throw new Error(errors.join(' | ') || 'Gemini agent request failed');
}

async function loadLightContext(chatId, focusedItemId) {
  const [history, memories, learnedRules, footer, destination] = await Promise.all([
    recentChatMessages(chatId, 10),
    listMemories(chatId, 12),
    getSetting('learned_title_rules'),
    getSetting('caption_footer_html'),
    getSetting('destination_chat_id'),
  ]);

  let item = null;
  if (focusedItemId) item = await getQueueItem(focusedItemId);
  if (!item) item = await getLatestQueueItem(chatId);
  if (!item) item = await getLatestAnyQueueItem(chatId);

  const itemText = item
    ? `id=${item.id}\nstatus=${item.status}\nkind=${item.media_kind}\nfilename=${item.file_name || '(none)'}\ncurrent title=${item.generated_title || '(none)'}\nsource caption=${String(item.original_caption || '(none)').slice(0, 1400)}`
    : '(no item)';

  const memoryText = memories?.length
    ? memories.slice(0, 8).map((m) => `- ${String(m.content || '').slice(0, 350)}`).join('\n')
    : '(none)';
  const learnedText = Array.isArray(learnedRules) && learnedRules.length
    ? learnedRules.slice(-8).map((r) => `- ${String(r).slice(0, 350)}`).join('\n')
    : '(none)';

  return {
    item,
    history,
    contextText: `CURRENT ITEM SUMMARY:\n${itemText}\n\nRECENT LONG-TERM MEMORY:\n${memoryText}\n\nRECENT LEARNED PREFERENCES:\n${learnedText}\n\nFOOTER CONFIGURED=${Boolean(footer)}\nDESTINATION CONFIGURED=${Boolean(destination || process.env.DESTINATION_CHAT_ID)}`,
  };
}

async function fallbackAssistant(text, runtime, context, error = null) {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();
  let reply = '';
  const effects = [];
  const toolsUsed = [];

  const use = async (name, args = {}) => {
    const result = await executeAgentTool(name, args, runtime);
    toolsUsed.push(name);
    collectEffects(result, effects);
    return result;
  };

  if (/\b(last|terakhir)\b.*\b(send|sent|hantar)\b|\b(send|sent|hantar)\b.*\b(last|terakhir)\b/i.test(t)) {
    const result = await use('get_last_sent_item');
    const item = result?.data;
    reply = item
      ? `Last send ialah ${item.title || item.file_name || 'Untitled'}${item.sent_at ? ` pada ${formatTime(item.sent_at)}` : ''}.`
      : 'Belum ada item SENT yang aku jumpa.';
  } else if (/\b(total|jumlah|berapa)\b.*\b(send|sent|hantar)\b|\b(send|sent|hantar)\b.*\b(total|jumlah|berapa)\b/i.test(t)) {
    const result = await use('get_total_sent');
    reply = `Total file yang dah SENT sekarang ${result?.data?.total_sent ?? 0}.`;
  } else if (/\b(pending|belum hantar|unsent)\b/i.test(t)) {
    const result = await use('list_pending_items', { limit: 10 });
    const rows = result?.data || [];
    reply = rows.length
      ? `Ada ${rows.length} item yang aku tunjuk sebagai pending/ready/failed sekarang. Yang paling awal: ${rows[0]?.title || rows[0]?.file_name || 'Untitled'}.`
      : 'Tak ada item pending sekarang.';
  } else if (context.item && wantsSerialIncluded(t)) {
    const originalResult = await use('get_original_caption', { item_id: context.item.id });
    const titleResult = await use('get_current_title', { item_id: context.item.id });
    const source = originalResult?.data?.original_caption || context.item.original_caption || '';
    const serial = extractSerialCandidate(source, context.item.file_name || '');
    const currentTitle = String(titleResult?.data?.title || context.item.generated_title || '').trim();

    if (serial) {
      const title = combineSerialAndTitle(serial, currentTitle);
      if (title !== currentTitle) {
        await use('learn_format_from_correction', {
          item_id: context.item.id,
          corrected_title: title,
          rule: 'Keep the source serial/model/product code together with the product title. Put the serial/code on the first line and product title below it when the source uses that format.',
        });
        reply = `Faham. Aku dah masukkan no siri ${serial} sekali dengan tajuk dan aku simpan cara ni untuk format macam ni.`;
      } else {
        reply = `Faham. No siri ${serial} memang dah ada sekali dengan tajuk.`;
      }
    } else {
      reply = 'Faham kau nak no siri sekali dengan tajuk. Tapi untuk item ni aku tak jumpa no siri yang cukup jelas dalam caption asal, jadi aku tak nak teka.';
    }
  } else if (context.item && /(buang|remove|padam|delete).*(hashtag)|hashtag.*(buang|remove|padam|delete)/i.test(t)) {
    await use('remove_hashtags', { item_id: context.item.id });
    reply = 'Okay, hashtag aku dah buang daripada tajuk dan aku kemas item ni.';
  } else if (/\b(send|hantar|publish|post)\b/i.test(t) && context.item) {
    await use('send_item', { item_id: context.item.id });
    reply = 'Okay, aku sediakan preview untuk confirmation SEND.';
  } else if (/^(hi|hai|hello|helo|halo|hey|yo|boss)\b/i.test(raw)) {
    reply = context.item
      ? 'Ya boss, aku ada. Aku masih pegang item terbaru ni. Cakap je apa kau nak aku buat.'
      : 'Ya boss, aku ada. Cakap je macam biasa.';
  } else if (/(faham tak|faham ke|kau faham|understand|jelas tak)/i.test(t)) {
    reply = 'Faham. Kau tak perlu ikut command atau format khas. Kau cakap je kerja yang kau nak, aku akan buat bila arahan tu jelas.';
  } else {
    reply = context.item
      ? 'Aku masih pegang item ni. Cakap je perubahan yang kau nak pada tajuk, caption atau workflow dan aku akan cuba buat terus.'
      : 'Aku ada. Cakap je macam biasa apa yang kau nak buat.';
  }

  autoPreviewAfterToolNames(toolsUsed, runtime, effects);

  const result = {
    reply,
    effects: dedupeEffects(effects),
    toolsUsed,
    focusedItemId: runtime.focusedItemId || context.item?.id || null,
  };

  if (error) console.error('Agent local fallback used:', safeError(error?.message || error));
  await saveConversation(runtime.chatId, text, reply);
  return result;
}

function wantsSerialIncluded(text) {
  const mentionsSerial = /(no\.?\s*siri|nombor\s*siri|serial|product\s*code|model\s*code|kode\s*model|kod\s*model|no\.?\s*model)/i.test(text);
  const asksInclude = /(ambil|masuk|masukkan|letak|include|kekal|kekalkan|kena|perlu|sekali|juga|bersama)/i.test(text);
  return mentionsSerial && asksInclude;
}

function extractSerialCandidate(caption, fileName = '') {
  const lines = String(caption || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => !x.startsWith('#'));

  const first = lines[0] || '';
  if (looksLikeSerial(first)) return first;

  const source = `${caption || ''}\n${fileName || ''}`;
  const tokens = source.match(/[A-Za-z0-9][A-Za-z0-9._-]{4,79}/g) || [];
  const candidate = tokens.find(looksLikeSerial);
  return candidate || '';
}

function looksLikeSerial(value) {
  const token = String(value || '').trim();
  if (token.length < 5 || token.length > 80) return false;
  if (/\s{2,}/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (!/[A-Za-z._-]/.test(token)) return false;
  if (/^https?:/i.test(token)) return false;
  return /^[A-Za-z0-9._-]+$/.test(token);
}

function combineSerialAndTitle(serial, currentTitle) {
  const normalizedSerial = String(serial || '').trim();
  const lines = String(currentTitle || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.toLowerCase() !== normalizedSerial.toLowerCase());
  return [normalizedSerial, ...lines].filter(Boolean).join('\n').slice(0, 180);
}

function collectEffects(result, effects) {
  const data = result?.data;
  const effect = data?.effect || result?.effect;
  if (effect?.type) effects.push(effect);
  if (Array.isArray(data?.effects)) effects.push(...data.effects.filter((x) => x?.type));
}

function autoPreviewAfterEdits(toolTrace, runtime, effects) {
  if (!runtime.focusedItemId) return;
  const edited = toolTrace.some((x) => MUTATING_ITEM_TOOLS.has(x.name));
  const already = effects.some((x) => x.type === 'preview_item' && x.item_id === runtime.focusedItemId);
  if (edited && !already) effects.push({ type: 'preview_item', item_id: runtime.focusedItemId });
}

function autoPreviewAfterToolNames(toolNames, runtime, effects) {
  if (!runtime.focusedItemId) return;
  const edited = toolNames.some((name) => MUTATING_ITEM_TOOLS.has(name));
  const already = effects.some((x) => x.type === 'preview_item' && x.item_id === runtime.focusedItemId);
  if (edited && !already) effects.push({ type: 'preview_item', item_id: runtime.focusedItemId });
}

function dedupeEffects(effects) {
  const seen = new Set();
  const out = [];
  for (const effect of effects || []) {
    const key = `${effect.type}:${effect.item_id || ''}:${effect.count || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(effect);
  }
  return out;
}

function safeToolResponse(result) {
  const json = JSON.stringify(result ?? { ok: true });
  if (json.length <= 7000) return result ?? { ok: true };
  return { ok: true, truncated: true, summary: json.slice(0, 6800) };
}

function sanitizeArgs(args) {
  const out = { ...(args || {}) };
  for (const key of Object.keys(out)) {
    if (/token|secret|key|password/i.test(key)) out[key] = '[HIDDEN]';
    if (typeof out[key] === 'string' && out[key].length > 500) out[key] = `${out[key].slice(0, 500)}…`;
  }
  return out;
}

async function saveConversation(chatId, userText, assistantText) {
  await Promise.allSettled([
    saveChatMessage(chatId, 'user', userText),
    saveChatMessage(chatId, 'assistant', assistantText || ''),
  ]);
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
    .slice(0, 500);
}

function formatTime(value) {
  try {
    return new Intl.DateTimeFormat('ms-MY', {
      timeZone: 'Asia/Kuala_Lumpur',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return String(value || '');
  }
}
