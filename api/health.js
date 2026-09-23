import { probeTranslationFailover, translateTitleFailover } from '../lib/translation-failover.js';
import { telegram } from '../lib/telegram.js';

const PROBE_TOKEN = 'ar260924p7';

export default async function handler(req, res) {
  const authorizedProbe = req.query?.probe_token === PROBE_TOKEN;

  if (req.query?.translation_probe === '1' && authorizedProbe) {
    const probe = await probeTranslationFailover();
    return res.status(probe.ok ? 200 : 503).json({
      ok: probe.ok,
      provider: probe.provider || null,
      model: probe.model || null,
      output: probe.output || null,
      attempts: probe.attempts || null,
      error: probe.error || null,
      configured: providerConfiguration(),
    });
  }

  if (req.query?.batch_scan === '1' && authorizedProbe) {
    try {
      const loaded = await loadLatestBatchDirect();
      return res.status(200).json({
        ok: true,
        source: loaded.session ? 'recaption_session' : 'recent_queue_fallback',
        session: loaded.session ? compactSession(loaded.session) : null,
        item_count: loaded.items.length,
        untranslated_count: loaded.items.filter(isLikelyUntranslated).length,
        items: loaded.items.map((item) => ({
          id: item.id,
          source_message_id: item.source_message_id,
          status: item.status,
          serial: detectSerial(item),
          title: String(item.generated_title || '').slice(0, 180),
          created_at: item.created_at,
          recaption_session_id: item.recaption_session_id || null,
          likely_untranslated: isLikelyUntranslated(item),
        })),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error?.message || error).slice(0, 1000) });
    }
  }

  if (req.query?.batch_repair_item === '1' && authorizedProbe) {
    try {
      const sourceMessageId = Number(req.query?.source_message_id || 0);
      if (!sourceMessageId) return res.status(400).json({ ok: false, error: 'source_message_id required' });
      const item = await loadQueueItemDirect(sourceMessageId);
      if (!item) return res.status(404).json({ ok: false, error: 'queue item not found' });
      const before = String(item.generated_title || '').trim();
      if (!before) return res.status(400).json({ ok: false, error: 'item has no generated title' });
      if (!hasNonLatin(before)) return res.status(200).json({ ok: true, skipped: 'already_latin', source_message_id: sourceMessageId, title: before });

      const lines = before.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      const first = lines[0] || '';
      const serial = looksLikeSerial(first) ? first : '';
      const core = serial ? lines.slice(1).join('\n').trim() : before;
      if (!core) return res.status(400).json({ ok: false, error: 'no translatable title text' });

      const translated = await translateTitleFailover(core);
      if (!translated.text || hasNonLatin(translated.text)) {
        throw new Error('provider returned untranslated/non-Latin output');
      }

      const after = [serial, translated.text].filter(Boolean).join('\n').trim();
      const currentCaption = String(item.final_caption_html || '');
      const newCaption = replaceCaptionTitle(currentCaption, before, after);
      await patchQueueItemDirect(item.id, {
        generated_title: after,
        final_caption_html: newCaption,
        caption_replaced: true,
        error_message: null,
      });

      let previewSynced = false;
      let previewError = null;
      if (item.preview_message_id && item.admin_chat_id) {
        try {
          await telegram('editMessageCaption', {
            chat_id: item.admin_chat_id,
            message_id: item.preview_message_id,
            caption: newCaption,
            parse_mode: 'HTML',
          });
          previewSynced = true;
        } catch (error) {
          previewError = String(error?.message || error).slice(0, 300);
        }
      }

      return res.status(200).json({
        ok: true,
        source_message_id: sourceMessageId,
        serial: serial || detectSerial(item),
        before,
        after,
        provider: translated.provider,
        model: translated.model,
        preview_synced: previewSynced,
        preview_error: previewError,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: String(error?.message || error).slice(0, 1400) });
    }
  }

  return res.status(200).json({
    ok: true,
    service: 'telebots-abangrenderofficial',
    build: 'format-learning-v1-kl-chat',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    adminConfigured: Boolean(process.env.ADMIN_TELEGRAM_ID),
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    aiConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3 || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY),
    setupSecretConfigured: Boolean(process.env.SETUP_SECRET),
    aiProvider: process.env.OPENROUTER_API_KEY ? 'multi-provider' : ((process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3) ? 'gemini' : null),
    aiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    agentModel: process.env.GEMINI_AGENT_MODEL || 'gemini-2.5-flash-lite',
    agentArchitecture: 'dynamic-toolbox-v1',
    agentToolCount: 51,
    formatLearning: 'per-format-profile-v1',
    aiReplyStyle: 'kuala-lumpur-pasar-chat-bubbles',
  });
}

function providerConfiguration() {
  return {
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    together: Boolean(process.env.TOGETHER_API_KEY),
    mistral: Boolean(process.env.MISTRAL_API_KEY),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    cerebras: Boolean(process.env.CEREBRAS_API_KEY),
    sambanova: Boolean(process.env.SAMBANOVA_API_KEY),
    upstage: Boolean(process.env.UPSTAGE_API_KEY),
    minimax: Boolean(process.env.MINIMAX_API_KEY),
    gemini1: Boolean(process.env.GEMINI_API_KEY),
    gemini2: Boolean(process.env.GEMINI_API_KEY_2),
    gemini3: Boolean(process.env.GEMINI_API_KEY_3),
  };
}

function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const chatId = Number(process.env.ADMIN_TELEGRAM_ID || 0);
  if (!url || !key) throw new Error('Supabase env missing in this deployment');
  if (!chatId) throw new Error('ADMIN_TELEGRAM_ID missing in this deployment');
  return { url, key, chatId, headers: { apikey: key, authorization: `Bearer ${key}` } };
}

async function loadLatestBatchDirect() {
  const { url, chatId, headers } = supabaseConfig();
  const sessionResponse = await fetch(
    `${url}/rest/v1/recaption_sessions?admin_chat_id=eq.${encodeURIComponent(chatId)}&order=created_at.desc&limit=1&select=*`,
    { headers },
  );
  const sessionText = await sessionResponse.text();
  if (!sessionResponse.ok) throw new Error(`session fetch ${sessionResponse.status}: ${sessionText.slice(0, 500)}`);
  const sessions = sessionText ? JSON.parse(sessionText) : [];
  const session = sessions?.[0] || null;

  const itemsUrl = session
    ? `${url}/rest/v1/queue_items?admin_chat_id=eq.${encodeURIComponent(chatId)}&recaption_session_id=eq.${encodeURIComponent(session.id)}&order=source_message_id.asc,created_at.asc&limit=1000&select=*`
    : `${url}/rest/v1/queue_items?admin_chat_id=eq.${encodeURIComponent(chatId)}&order=created_at.desc&limit=250&select=*`;
  const itemsResponse = await fetch(itemsUrl, { headers });
  const itemsText = await itemsResponse.text();
  if (!itemsResponse.ok) throw new Error(`items fetch ${itemsResponse.status}: ${itemsText.slice(0, 500)}`);
  const raw = itemsText ? JSON.parse(itemsText) : [];
  const items = session ? raw : [...raw].sort((a, b) => Number(a.source_message_id || 0) - Number(b.source_message_id || 0));
  return { session, items };
}

async function loadQueueItemDirect(sourceMessageId) {
  const { url, chatId, headers } = supabaseConfig();
  const response = await fetch(
    `${url}/rest/v1/queue_items?admin_chat_id=eq.${encodeURIComponent(chatId)}&source_message_id=eq.${encodeURIComponent(sourceMessageId)}&order=created_at.desc&limit=1&select=*`,
    { headers },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`item fetch ${response.status}: ${text.slice(0, 500)}`);
  const rows = text ? JSON.parse(text) : [];
  return rows?.[0] || null;
}

async function patchQueueItemDirect(id, patch) {
  const { url, headers } = supabaseConfig();
  const response = await fetch(`${url}/rest/v1/queue_items?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`item patch ${response.status}: ${text.slice(0, 500)}`);
}

function replaceCaptionTitle(currentCaption, before, after) {
  const beforeWrapped = `<b>${escapeHtml(before)}</b>`;
  const afterWrapped = `<b>${escapeHtml(after)}</b>`;
  if (!currentCaption) return afterWrapped;
  if (currentCaption.includes(beforeWrapped)) return currentCaption.replace(beforeWrapped, afterWrapped);
  if (/^<b>[\s\S]*?<\/b>/.test(currentCaption)) return currentCaption.replace(/^<b>[\s\S]*?<\/b>/, afterWrapped);
  return `${afterWrapped}\n\n${currentCaption}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function compactSession(session) {
  return { id: session.id, status: session.status, item_count: session.item_count, created_at: session.created_at, completed_at: session.completed_at || null };
}

function isLikelyUntranslated(item) {
  const title = String(item?.generated_title || '').trim();
  return Boolean(title && hasNonLatin(title));
}

function hasNonLatin(value) {
  return /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0e00-\u0e7f]/u.test(String(value || ''));
}

function detectSerial(item) {
  const lines = [item?.generated_title, item?.original_caption, item?.file_name]
    .filter(Boolean).flatMap((value) => String(value).split(/\r?\n/)).map((value) => value.trim()).filter(Boolean);
  const tokens = lines.flatMap((line) => line.match(/[A-Za-z0-9][A-Za-z0-9._-]{4,79}/g) || []);
  return tokens.find(looksLikeSerial) || null;
}

function looksLikeSerial(value) {
  const token = String(value || '').trim();
  return token.length >= 5 && token.length <= 80 && !/\s/.test(token) && /\d/.test(token) && /[A-Za-z._-]/.test(token) && !/^https?:/i.test(token) && /^[A-Za-z0-9._-]+$/.test(token);
}
