import {
  addMemory,
  deleteMemory,
  getLatestAnyQueueItem,
  getLatestQueueItem,
  getQueueItem,
  getSetting,
  listMemories,
  listPending,
  listQueueItems,
  listQueueItemsByStatus,
  listSentItems,
  recentExamples,
  saveExample,
  searchQueueItems,
  setSetting,
  stats,
  updateQueueItem,
} from './store.js';
import { buildCaption, escapeHtml, generateTitle } from './caption.js';
import { telegramSubstringToHtml } from './entities.js';
import { telegram } from './telegram.js';

const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const stringProp = (description) => ({ type: 'string', description });
const integerProp = (description) => ({ type: 'integer', description });
const booleanProp = (description) => ({ type: 'boolean', description });

const TOOL_DEFS = [
  def('get_current_item', 'Read the media item currently in focus. Use this for references like this one, yang ni, file ni, or tadi.', 'items'),
  def('get_latest_item', 'Read the newest received media item, including sent or skipped items.', 'items'),
  def('search_queue', 'Search queue/history by title, filename, caption text, model/serial, or destination.', 'items', objectSchema({ query: stringProp('Text to search for'), limit: integerProp('Maximum results, usually 5 to 20') }, ['query'])),
  def('get_original_caption', 'Read the original incoming caption for an item.', 'items', itemIdSchema()),
  def('get_current_title', 'Read the current generated title for an item.', 'items', itemIdSchema()),
  def('get_current_caption', 'Read the current final caption HTML for an item.', 'items', itemIdSchema()),
  def('get_item_history', 'Read recorded AI changes for an item so you can explain or restore previous changes.', 'items', itemIdSchema()),
  def('detect_duplicate', 'Check whether the current/specified item appears to duplicate another queue item using Telegram unique id or normalized title/caption.', 'items', itemIdSchema()),

  def('update_title', 'Replace an item title with the exact final title. Footer is rebuilt automatically. Use for direct title corrections.', 'edit', objectSchema({ item_id: stringProp('Optional queue item UUID'), title: stringProp('Exact final product/model title only') }, ['title'])),
  def('update_caption', 'Replace the full final caption for an item. Use only when the owner wants a one-off whole-caption replacement rather than the reusable footer.', 'edit', objectSchema({ item_id: stringProp('Optional queue item UUID'), caption: stringProp('Exact final caption text') }, ['caption'])),
  def('append_caption', 'Append text to the current final caption of an item.', 'edit', objectSchema({ item_id: stringProp('Optional queue item UUID'), text: stringProp('Text to append') }, ['text'])),
  def('set_footer', 'Save/replace the reusable footer shown below titles. If content is copied from the current Telegram message, formatting and hidden links are preserved where possible.', 'edit', objectSchema({ content: stringProp('Exact footer text only, excluding the owner instruction sentence'), apply_to_current: booleanProp('Whether to apply it to the current item now') }, ['content'])),
  def('get_footer', 'Read the currently saved reusable footer.', 'edit'),
  def('apply_footer', 'Rebuild the current/specified item caption using its current title plus the saved footer.', 'edit', itemIdSchema()),
  def('remove_hashtags', 'Remove hashtag lines from the title/source interpretation and update the current/specified item title.', 'edit', itemIdSchema()),
  def('translate_title', 'Set the current/specified title to the English translation supplied by you while preserving brands/model codes.', 'edit', objectSchema({ item_id: stringProp('Optional queue item UUID'), translated_title: stringProp('Exact translated final title') }, ['translated_title'])),
  def('clean_title', 'Clean noise from a title and save the exact cleaned title supplied by you.', 'edit', objectSchema({ item_id: stringProp('Optional queue item UUID'), cleaned_title: stringProp('Exact cleaned final title') }, ['cleaned_title'])),
  def('extract_title', 'Extract a fresh title from the original caption/filename using the bot title extractor and save it.', 'edit', itemIdSchema()),

  def('preview_item', 'Ask the Telegram layer to show a preview of the current/specified item with the SEND confirmation button.', 'send', itemIdSchema()),
  def('send_item', 'Prepare the current/specified item for sending. This never publishes immediately from natural language; it returns a preview confirmation effect.', 'send', itemIdSchema()),
  def('send_all_ready', 'Prepare all READY/FAILED items for bulk-send confirmation. Do not publish silently.', 'send'),
  def('skip_item', 'Mark the current/specified item as SKIPPED.', 'send', itemIdSchema()),
  def('get_send_status', 'Read whether the current/specified item is pending, ready, sent, failed, or skipped and its sent time/destination.', 'send', itemIdSchema()),
  def('get_last_sent_item', 'Get the most recently successfully sent item.', 'send'),
  def('get_last_sent_time', 'Get the sent time of the most recently sent item.', 'send'),
  def('get_last_sent_destination', 'Get the destination of the most recently sent item.', 'send'),
  def('get_last_n_sent_items', 'Get the most recent N successfully sent items.', 'send', objectSchema({ count: integerProp('How many recent sent items to return, 1 to 20') })),

  def('get_stats', 'Get the main document/file statistics: total, sent, pending, failed, skipped, captions replaced.', 'stats'),
  def('get_total_sent', 'Count successfully sent primary files/documents.', 'stats'),
  def('get_total_received', 'Count all primary files/documents received by the bot regardless of status.', 'stats'),
  def('get_total_pending', 'Count primary files/documents still PENDING or READY.', 'stats'),
  def('get_total_failed', 'Count primary files/documents currently FAILED.', 'stats'),
  def('get_total_skipped', 'Count primary files/documents marked SKIPPED.', 'stats'),
  def('get_today_sent', 'Count items sent today. Can optionally count a specific media type.', 'stats', objectSchema({ media_kind: stringProp('Optional: document, photo, video, animation, audio, or all') })),
  def('get_sent_by_date_range', 'Count sent items between start and end dates/times.', 'stats', objectSchema({ start: stringProp('ISO date/time or YYYY-MM-DD start'), end: stringProp('ISO date/time or YYYY-MM-DD end'), media_kind: stringProp('Optional media kind or all') }, ['start', 'end'])),
  def('get_sent_by_media_type', 'Count sent items grouped by media type.', 'stats'),
  def('get_send_summary', 'Return a compact overall send summary including last sent item and main counts.', 'stats'),
  def('list_pending_items', 'List current PENDING, READY, or FAILED items.', 'stats', objectSchema({ limit: integerProp('Maximum results, usually 5 to 30') })),

  def('save_memory', 'Save a durable owner preference or fact for future conversations.', 'memory', objectSchema({ content: stringProp('Reusable memory to save') }, ['content'])),
  def('search_memory', 'Search saved long-term memories by meaning/words.', 'memory', objectSchema({ query: stringProp('What to search memories for') }, ['query'])),
  def('list_memories', 'List saved long-term memories.', 'memory', objectSchema({ limit: integerProp('Maximum memories to return') })),
  def('delete_memory', 'Delete one long-term memory by its numeric id. Use only when owner clearly asks to forget/delete it.', 'memory', objectSchema({ id: integerProp('Memory id') }, ['id'])),
  def('save_learning_example', 'Save an original-caption to corrected-title example so future title extraction can learn from it.', 'learning', objectSchema({ item_id: stringProp('Optional queue item UUID'), corrected_title: stringProp('Correct title to learn') }, ['corrected_title'])),
  def('detect_new_format', 'Check the latest format-learning notice and amount of prior teaching data to judge whether the current format looks unfamiliar.', 'learning'),
  def('learn_format_from_correction', 'Save the current item correction plus a reusable learned preference in the background.', 'learning', objectSchema({ item_id: stringProp('Optional queue item UUID'), corrected_title: stringProp('Correct final title'), rule: stringProp('Short reusable lesson for similar future captions') }, ['corrected_title', 'rule'])),
  def('summarize_learnings', 'Summarize learned title preferences and recent correction examples.', 'learning'),

  def('set_destination', 'Set the Telegram destination chat/channel id or username. Use only when the owner explicitly asks to change destination.', 'admin', objectSchema({ destination: stringProp('Telegram chat id or @username') }, ['destination'])),
  def('get_destination', 'Read the current configured send destination.', 'admin'),
  def('validate_destination', 'Check whether Telegram can resolve the current or supplied destination.', 'admin', objectSchema({ destination: stringProp('Optional Telegram chat id or @username') })),
  def('undo_last_change', 'Undo the most recent reversible AI edit/configuration change.', 'admin'),
  def('explain_last_action', 'Read the most recent recorded AI tool action and what it changed.', 'admin'),
];

export const DISCOVER_TOOL = {
  name: 'discover_tools',
  description: 'Find additional bot tools/capabilities relevant to a task. Use this when the needed action is not in the currently exposed toolbox.',
  parameters: objectSchema({ query: stringProp('Describe the capability you need, e.g. footer, last sent, duplicate, memory, statistics') }, ['query']),
};

const TOOL_MAP = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));

export function getInitialToolDeclarations() {
  const names = [
    'get_current_item',
    'get_latest_item',
    'search_queue',
    'preview_item',
    'send_item',
    'get_stats',
    'get_last_sent_item',
    'save_memory',
  ];
  return [DISCOVER_TOOL, ...names.map((name) => declaration(TOOL_MAP.get(name)))];
}

export function getToolDeclarations(names = []) {
  return names.map((name) => TOOL_MAP.get(name)).filter(Boolean).map(declaration);
}

export function discoverTools(query) {
  const q = normalize(query);
  const scored = TOOL_DEFS.map((tool) => {
    const hay = normalize(`${tool.name} ${tool.description} ${tool.category}`);
    let score = 0;
    for (const token of q.split(/\s+/).filter((x) => x.length > 2)) {
      if (hay.includes(token)) score += token.length;
    }
    if (hay.includes(q) && q.length > 2) score += 20;
    return { tool, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map((x) => x.tool);

  if (scored.length) return scored.map((t) => ({ name: t.name, description: t.description, category: t.category }));

  return TOOL_DEFS.filter((tool) => [
    'update_title', 'update_caption', 'set_footer', 'apply_footer',
    'list_pending_items', 'get_total_sent', 'get_last_n_sent_items',
    'search_memory', 'learn_format_from_correction', 'get_destination',
    'undo_last_change',
  ].includes(tool.name)).map((t) => ({ name: t.name, description: t.description, category: t.category }));
}

export async function executeAgentTool(name, args = {}, runtime = {}) {
  if (name === 'discover_tools') {
    return { ok: true, tools: discoverTools(args.query || '') };
  }

  const chatId = runtime.chatId;
  if (!chatId) return { ok: false, error: 'Missing chat context' };

  try {
    switch (name) {
      case 'get_current_item':
        return ok(await resolveItem(runtime, args.item_id));
      case 'get_latest_item':
        return ok(await getLatestAnyQueueItem(chatId));
      case 'search_queue':
        return ok(await searchQueueItems(chatId, args.query, clamp(args.limit, 10, 20)));
      case 'get_original_caption': {
        const item = await requireItem(runtime, args.item_id);
        return ok({ item_id: item.id, original_caption: item.original_caption || '' });
      }
      case 'get_current_title': {
        const item = await requireItem(runtime, args.item_id);
        return ok({ item_id: item.id, title: item.generated_title || '' });
      }
      case 'get_current_caption': {
        const item = await requireItem(runtime, args.item_id);
        return ok({ item_id: item.id, caption_html: item.final_caption_html || '' });
      }
      case 'get_item_history': {
        const item = await requireItem(runtime, args.item_id);
        const history = await getActionHistory(chatId);
        return ok(history.filter((x) => x.item_id === item.id).slice(-20).reverse());
      }
      case 'detect_duplicate': {
        const item = await requireItem(runtime, args.item_id);
        const rows = await listQueueItems(chatId, 500);
        const duplicates = findDuplicates(item, rows || []);
        return ok({ item_id: item.id, duplicate: duplicates.length > 0, matches: duplicates.slice(0, 10).map(compactItem) });
      }

      case 'update_title': {
        const item = await requireItem(runtime, args.item_id);
        const title = cleanTitle(args.title);
        if (!title) throw new Error('Title kosong');
        const before = snapshotItem(item);
        const updated = await updateQueueItem(item.id, {
          generated_title: title,
          final_caption_html: await buildCaption(title),
          status: item.status === 'SENT' ? item.status : 'READY',
          caption_replaced: true,
        });
        await recordChange(chatId, name, item.id, before, snapshotItem(updated), `Title ditukar ke: ${title}`);
        runtime.focusedItemId = item.id;
        return ok(compactItem(updated));
      }
      case 'update_caption': {
        const item = await requireItem(runtime, args.item_id);
        const caption = String(args.caption || '').trim();
        if (!caption) throw new Error('Caption kosong');
        const before = snapshotItem(item);
        const updated = await updateQueueItem(item.id, {
          final_caption_html: escapeHtml(caption),
          caption_replaced: true,
          status: item.status === 'SENT' ? item.status : 'READY',
        });
        await recordChange(chatId, name, item.id, before, snapshotItem(updated), 'Caption penuh dikemas kini');
        runtime.focusedItemId = item.id;
        return ok(compactItem(updated));
      }
      case 'append_caption': {
        const item = await requireItem(runtime, args.item_id);
        const text = String(args.text || '').trim();
        if (!text) throw new Error('Text kosong');
        const before = snapshotItem(item);
        const updated = await updateQueueItem(item.id, {
          final_caption_html: `${item.final_caption_html || ''}\n\n${escapeHtml(text)}`.trim(),
          caption_replaced: true,
          status: item.status === 'SENT' ? item.status : 'READY',
        });
        await recordChange(chatId, name, item.id, before, snapshotItem(updated), 'Text ditambah ke caption');
        runtime.focusedItemId = item.id;
        return ok(compactItem(updated));
      }
      case 'set_footer': {
        const content = String(args.content || '').trim();
        if (!content) throw new Error('Footer kosong');
        const oldFooter = await getSetting('caption_footer_html');
        const footerHtml = runtime.ownerText
          ? telegramSubstringToHtml(runtime.ownerText, runtime.ownerEntities || [], content)
          : escapeHtml(content);
        await setSetting('caption_footer_html', footerHtml);
        await recordChange(chatId, name, null, { caption_footer_html: oldFooter }, { caption_footer_html: footerHtml }, 'Reusable footer dikemas kini');

        let item = null;
        if (args.apply_to_current !== false) item = await resolveItem(runtime);
        if (item) {
          const before = snapshotItem(item);
          const updated = await updateQueueItem(item.id, {
            final_caption_html: await buildCaption(item.generated_title || 'Untitled'),
            caption_replaced: true,
            status: item.status === 'SENT' ? item.status : 'READY',
          });
          await recordChange(chatId, 'apply_footer', item.id, before, snapshotItem(updated), 'Footer baru diaplikasi pada item semasa');
          runtime.focusedItemId = item.id;
          return ok({ saved: true, applied_item: compactItem(updated) });
        }
        return ok({ saved: true, applied_item: null });
      }
      case 'get_footer':
        return ok({ footer_html: (await getSetting('caption_footer_html')) || '' });
      case 'apply_footer': {
        const item = await requireItem(runtime, args.item_id);
        const before = snapshotItem(item);
        const updated = await updateQueueItem(item.id, {
          final_caption_html: await buildCaption(item.generated_title || 'Untitled'),
          caption_replaced: true,
          status: item.status === 'SENT' ? item.status : 'READY',
        });
        await recordChange(chatId, name, item.id, before, snapshotItem(updated), 'Saved footer diaplikasi');
        runtime.focusedItemId = item.id;
        return ok(compactItem(updated));
      }
      case 'remove_hashtags': {
        const item = await requireItem(runtime, args.item_id);
        const title = cleanTitle(
          String(item.original_caption || item.generated_title || '')
            .split(/\r?\n/)
            .map((x) => x.trim())
            .filter(Boolean)
            .filter((x) => !x.startsWith('#'))
            .slice(0, 2)
            .join('\n'),
        );
        return executeAgentTool('update_title', { item_id: item.id, title: title || item.generated_title }, runtime);
      }
      case 'translate_title':
        return executeAgentTool('update_title', { item_id: args.item_id, title: args.translated_title }, runtime);
      case 'clean_title':
        return executeAgentTool('update_title', { item_id: args.item_id, title: args.cleaned_title }, runtime);
      case 'extract_title': {
        const item = await requireItem(runtime, args.item_id);
        const title = await generateTitle({ caption: item.original_caption || '', fileName: item.file_name || '' });
        return executeAgentTool('update_title', { item_id: item.id, title }, runtime);
      }

      case 'preview_item': {
        const item = await requireItem(runtime, args.item_id);
        runtime.focusedItemId = item.id;
        return ok({ effect: { type: 'preview_item', item_id: item.id }, item: compactItem(item) });
      }
      case 'send_item': {
        const item = await requireItem(runtime, args.item_id);
        runtime.focusedItemId = item.id;
        return ok({ requires_confirmation: true, effect: { type: 'preview_item', item_id: item.id }, item: compactItem(item) });
      }
      case 'send_all_ready': {
        const items = await listPending(50);
        const sendable = (items || []).filter((x) => ['READY', 'FAILED'].includes(x.status));
        return ok({ requires_confirmation: true, count: sendable.length, effect: { type: 'confirm_send_all', count: sendable.length } });
      }
      case 'skip_item': {
        const item = await requireItem(runtime, args.item_id);
        const before = snapshotItem(item);
        const updated = await updateQueueItem(item.id, { status: 'SKIPPED' });
        await recordChange(chatId, name, item.id, before, snapshotItem(updated), 'Item ditanda SKIPPED');
        return ok(compactItem(updated));
      }
      case 'get_send_status': {
        const item = await requireItem(runtime, args.item_id);
        return ok({ item_id: item.id, title: item.generated_title, file_name: item.file_name, status: item.status, sent_at: item.sent_at, destination: item.destination_chat_id, error: item.error_message });
      }
      case 'get_last_sent_item': {
        const rows = await listSentItems(chatId, 1);
        return ok(rows?.[0] ? compactItem(rows[0]) : null);
      }
      case 'get_last_sent_time': {
        const rows = await listSentItems(chatId, 1);
        return ok({ sent_at: rows?.[0]?.sent_at || null, item: rows?.[0] ? compactItem(rows[0]) : null });
      }
      case 'get_last_sent_destination': {
        const rows = await listSentItems(chatId, 1);
        return ok({ destination: rows?.[0]?.destination_chat_id || null, item: rows?.[0] ? compactItem(rows[0]) : null });
      }
      case 'get_last_n_sent_items': {
        const rows = await listSentItems(chatId, clamp(args.count, 5, 20));
        return ok((rows || []).map(compactItem));
      }

      case 'get_stats':
        return ok(await stats());
      case 'get_total_sent': {
        const s = await stats(); return ok({ total_sent: s.sent });
      }
      case 'get_total_received': {
        const s = await stats(); return ok({ total_received: s.total });
      }
      case 'get_total_pending': {
        const s = await stats(); return ok({ total_pending: s.pending });
      }
      case 'get_total_failed': {
        const s = await stats(); return ok({ total_failed: s.failed });
      }
      case 'get_total_skipped': {
        const s = await stats(); return ok({ total_skipped: s.skipped || 0 });
      }
      case 'get_today_sent': {
        const rows = await listSentItems(chatId, 1000);
        const start = startOfToday();
        const kind = normalizeKind(args.media_kind);
        const filtered = (rows || []).filter((x) => new Date(x.sent_at || x.created_at).getTime() >= start && (!kind || x.media_kind === kind));
        return ok({ count: filtered.length, media_kind: kind || 'all' });
      }
      case 'get_sent_by_date_range': {
        const start = parseDate(args.start, false);
        const end = parseDate(args.end, true);
        if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Tarikh tak valid');
        const kind = normalizeKind(args.media_kind);
        const rows = await listSentItems(chatId, 1000);
        const filtered = (rows || []).filter((x) => {
          const t = new Date(x.sent_at || x.created_at).getTime();
          return t >= start && t <= end && (!kind || x.media_kind === kind);
        });
        return ok({ count: filtered.length, start: new Date(start).toISOString(), end: new Date(end).toISOString(), media_kind: kind || 'all' });
      }
      case 'get_sent_by_media_type': {
        const rows = await listSentItems(chatId, 1000);
        const grouped = {};
        for (const row of rows || []) grouped[row.media_kind || 'other'] = (grouped[row.media_kind || 'other'] || 0) + 1;
        return ok(grouped);
      }
      case 'get_send_summary': {
        const [s, sent] = await Promise.all([stats(), listSentItems(chatId, 1)]);
        return ok({ ...s, last_sent: sent?.[0] ? compactItem(sent[0]) : null });
      }
      case 'list_pending_items': {
        const rows = await listPending(clamp(args.limit, 10, 50));
        return ok((rows || []).map(compactItem));
      }

      case 'save_memory': {
        const content = String(args.content || '').trim();
        if (!content) throw new Error('Memory kosong');
        const saved = await addMemory(chatId, content);
        return ok(saved);
      }
      case 'search_memory': {
        const memories = await listMemories(chatId, 100);
        const q = normalize(args.query);
        const tokens = q.split(/\s+/).filter(Boolean);
        const found = (memories || []).map((m) => {
          const hay = normalize(m.content);
          const score = tokens.reduce((n, token) => n + (hay.includes(token) ? token.length : 0), 0);
          return { ...m, score };
        }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
        return ok(found);
      }
      case 'list_memories':
        return ok(await listMemories(chatId, clamp(args.limit, 20, 50)));
      case 'delete_memory':
        return ok(await deleteMemory(chatId, Number(args.id)));
      case 'save_learning_example': {
        const item = await requireItem(runtime, args.item_id);
        const corrected = cleanTitle(args.corrected_title);
        if (!corrected) throw new Error('Corrected title kosong');
        const saved = await saveExample(item.original_caption || item.file_name || '', corrected);
        return ok(saved);
      }
      case 'detect_new_format': {
        const [notice, examples] = await Promise.all([getSetting('format_learning_notice'), recentExamples(30)]);
        return ok({ unfamiliar: Boolean(notice?.unknown), notice: notice || null, learned_examples: examples?.length || 0 });
      }
      case 'learn_format_from_correction': {
        const item = await requireItem(runtime, args.item_id);
        const corrected = cleanTitle(args.corrected_title);
        const rule = String(args.rule || '').trim().slice(0, 500);
        if (!corrected || !rule) throw new Error('Correction/rule tak lengkap');
        await saveExample(item.original_caption || item.file_name || '', corrected);
        const rules = await addLearnedRule(rule);
        if (corrected !== item.generated_title) {
          await executeAgentTool('update_title', { item_id: item.id, title: corrected }, runtime);
        }
        return ok({ learned: true, corrected_title: corrected, rule, learned_rule_count: rules.length });
      }
      case 'summarize_learnings': {
        const [rules, examples] = await Promise.all([getSetting('learned_title_rules'), recentExamples(8)]);
        return ok({ rules: Array.isArray(rules) ? rules.slice(-20) : [], recent_examples: examples || [] });
      }

      case 'set_destination': {
        const destination = String(args.destination || '').trim();
        if (!destination) throw new Error('Destination kosong');
        const old = await getSetting('destination_chat_id');
        await setSetting('destination_chat_id', destination);
        await recordChange(chatId, name, null, { destination_chat_id: old }, { destination_chat_id: destination }, `Destination ditukar ke ${destination}`);
        return ok({ destination });
      }
      case 'get_destination':
        return ok({ destination: (await getSetting('destination_chat_id')) || process.env.DESTINATION_CHAT_ID || null });
      case 'validate_destination': {
        const destination = String(args.destination || (await getSetting('destination_chat_id')) || process.env.DESTINATION_CHAT_ID || '').trim();
        if (!destination) return ok({ valid: false, reason: 'Destination belum configured' });
        try {
          const chat = await telegram('getChat', { chat_id: destination });
          return ok({ valid: true, destination, chat: { id: chat.id, type: chat.type, title: chat.title || null, username: chat.username || null } });
        } catch (error) {
          return ok({ valid: false, destination, reason: error.message });
        }
      }
      case 'undo_last_change': {
        const history = await getActionHistory(chatId);
        const entry = [...history].reverse().find((x) => x.reversible !== false && x.before);
        if (!entry) return ok({ undone: false, reason: 'Tak ada perubahan yang boleh di-undo.' });

        if (entry.item_id) {
          const patch = reversibleItemPatch(entry.before);
          await updateQueueItem(entry.item_id, patch);
          runtime.focusedItemId = entry.item_id;
        } else if (Object.prototype.hasOwnProperty.call(entry.before, 'caption_footer_html')) {
          await setSetting('caption_footer_html', entry.before.caption_footer_html ?? null);
        } else if (Object.prototype.hasOwnProperty.call(entry.before, 'destination_chat_id')) {
          await setSetting('destination_chat_id', entry.before.destination_chat_id ?? null);
        }

        entry.reversible = false;
        entry.undone_at = new Date().toISOString();
        await setActionHistory(chatId, history);
        return ok({ undone: true, action: entry.action, item_id: entry.item_id, summary: entry.summary, effect: entry.item_id ? { type: 'preview_item', item_id: entry.item_id } : null });
      }
      case 'explain_last_action': {
        const history = await getActionHistory(chatId);
        return ok(history.length ? history[history.length - 1] : null);
      }
      default:
        return { ok: false, error: `Tool tak dikenali: ${name}` };
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'Tool failed').slice(0, 500) };
  }
}

function def(name, description, category, parameters = objectSchema()) {
  return { name, description, category, parameters };
}

function declaration(tool) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function itemIdSchema() {
  return objectSchema({ item_id: stringProp('Optional queue item UUID. Omit to use current/focused item.') });
}

async function resolveItem(runtime, explicitId = null) {
  if (explicitId) return getQueueItem(explicitId);
  if (runtime.focusedItemId) {
    const focused = await getQueueItem(runtime.focusedItemId);
    if (focused) return focused;
  }
  return getLatestQueueItem(runtime.chatId) || getLatestAnyQueueItem(runtime.chatId);
}

async function requireItem(runtime, explicitId = null) {
  const item = await resolveItem(runtime, explicitId);
  if (!item) throw new Error('Tak ada item yang sesuai sekarang');
  return item;
}

function ok(data) {
  return { ok: true, data };
}

function compactItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    status: item.status,
    media_kind: item.media_kind,
    file_name: item.file_name,
    title: item.generated_title,
    original_caption: String(item.original_caption || '').slice(0, 1200),
    sent_at: item.sent_at,
    destination_chat_id: item.destination_chat_id,
    error_message: item.error_message,
    created_at: item.created_at,
  };
}

function snapshotItem(item) {
  if (!item) return null;
  return {
    generated_title: item.generated_title ?? null,
    final_caption_html: item.final_caption_html ?? null,
    status: item.status ?? null,
    caption_replaced: Boolean(item.caption_replaced),
    destination_chat_id: item.destination_chat_id ?? null,
    destination_message_id: item.destination_message_id ?? null,
    sent_at: item.sent_at ?? null,
    error_message: item.error_message ?? null,
  };
}

function reversibleItemPatch(snapshot) {
  return {
    generated_title: snapshot.generated_title,
    final_caption_html: snapshot.final_caption_html,
    status: snapshot.status,
    caption_replaced: snapshot.caption_replaced,
    destination_chat_id: snapshot.destination_chat_id,
    destination_message_id: snapshot.destination_message_id,
    sent_at: snapshot.sent_at,
    error_message: snapshot.error_message,
  };
}

function findDuplicates(item, rows) {
  const unique = String(item.file_unique_id || '');
  const title = normalize(item.generated_title || item.original_caption || item.file_name || '');
  return rows.filter((row) => {
    if (!row || row.id === item.id) return false;
    if (unique && row.file_unique_id && String(row.file_unique_id) === unique) return true;
    const other = normalize(row.generated_title || row.original_caption || row.file_name || '');
    return title && other && (title === other || (title.length > 12 && (title.includes(other) || other.includes(title))));
  });
}

function cleanTitle(value) {
  return String(value || '')
    .split(/\n\s*(?:Tutorial Download|More collection here)\s*:?/i)[0]
    .replace(/^\s*(?:title|tajuk)\s*:\s*/i, '')
    .trim()
    .slice(0, 180);
}

function clamp(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeKind(value) {
  const kind = String(value || '').toLowerCase().trim();
  return ['document', 'photo', 'video', 'animation', 'audio', 'other'].includes(kind) ? kind : null;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseDate(value, endOfDay = false) {
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const d = new Date(dateOnly ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00'}` : raw);
  return d.getTime();
}

async function addLearnedRule(rule) {
  const current = await getSetting('learned_title_rules');
  const rules = Array.isArray(current) ? current : [];
  if (!rules.some((r) => normalize(r) === normalize(rule))) {
    rules.push(rule);
    await setSetting('learned_title_rules', rules.slice(-60));
  }
  return rules.slice(-60);
}

const historyKey = (chatId) => `agent_action_history_${chatId}`;

async function getActionHistory(chatId) {
  const value = await getSetting(historyKey(chatId));
  return Array.isArray(value) ? value : [];
}

async function setActionHistory(chatId, history) {
  return setSetting(historyKey(chatId), (history || []).slice(-80));
}

async function recordChange(chatId, action, itemId, before, after, summary) {
  const history = await getActionHistory(chatId);
  history.push({
    action,
    item_id: itemId || null,
    before: before ?? null,
    after: after ?? null,
    summary: String(summary || '').slice(0, 500),
    created_at: new Date().toISOString(),
    reversible: true,
  });
  await setActionHistory(chatId, history);
}
