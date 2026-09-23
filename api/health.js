import { getProfileForItem } from '../lib/format-profiles.js';
import {
  getLatestRecaptionSession,
  listRecaptionSessionItems,
} from '../lib/bot/features/recaption-collection.js';
import { recaptionItemWithProfile } from '../lib/bot/features/recaption.js';
import { probeTranslationFailover } from '../lib/translation-failover.js';

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
      configured: {
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
      },
    });
  }

  if (req.query?.batch_scan === '1' && authorizedProbe) {
    const loaded = await loadLatestBatch();
    if (!loaded.session) return res.status(404).json({ ok: false, error: 'no recaption session' });
    return res.status(200).json({
      ok: true,
      session: compactSession(loaded.session),
      item_count: loaded.items.length,
      untranslated_count: loaded.items.filter(isLikelyUntranslated).length,
      items: loaded.items.map((item) => ({
        id: item.id,
        source_message_id: item.source_message_id,
        status: item.status,
        serial: detectSerial(item),
        title: String(item.generated_title || '').slice(0, 180),
        has_non_latin_title: hasNonLatin(item.generated_title),
        likely_untranslated: isLikelyUntranslated(item),
      })),
    });
  }

  if (req.query?.batch_repair === '1' && authorizedProbe) {
    const loaded = await loadLatestBatch();
    if (!loaded.session) return res.status(404).json({ ok: false, error: 'no recaption session' });

    const startMessageId = Number(req.query?.start_source_message_id || 0);
    const afterMessageId = Number(req.query?.after_source_message_id || 0);
    const limit = Math.min(Math.max(Number(req.query?.limit || 1), 1), 2);
    const includeSent = req.query?.include_sent === '1';
    const allowedStatuses = includeSent
      ? new Set(['PENDING', 'READY', 'FAILED', 'SENT'])
      : new Set(['PENDING', 'READY', 'FAILED']);

    let candidates = loaded.items.filter((item) => allowedStatuses.has(String(item.status || '').toUpperCase()));
    if (startMessageId) candidates = candidates.filter((item) => Number(item.source_message_id || 0) >= startMessageId);
    if (afterMessageId) candidates = candidates.filter((item) => Number(item.source_message_id || 0) > afterMessageId);
    candidates = candidates.filter(isLikelyUntranslated);

    const selected = candidates.slice(0, limit);
    const results = [];
    for (const item of selected) {
      try {
        const profile = await getProfileForItem(item);
        if (!profile) throw new Error('format profile missing');
        const forced = {
          ...profile,
          actions: {
            ...(profile.actions || {}),
            take_title: true,
            translate: true,
          },
        };
        const result = await recaptionItemWithProfile(item.id, forced, {
          reason: 'manual_latest_batch_translation_repair',
          syncSent: includeSent,
        });
        results.push({
          id: item.id,
          source_message_id: item.source_message_id,
          serial: detectSerial(item),
          ok: true,
          before: String(item.generated_title || '').slice(0, 180),
          after: String(result?.processed?.title || '').slice(0, 180),
        });
      } catch (error) {
        results.push({
          id: item.id,
          source_message_id: item.source_message_id,
          serial: detectSerial(item),
          ok: false,
          error: String(error?.message || error).slice(0, 600),
        });
      }
    }

    const lastProcessed = results.length ? Number(results[results.length - 1].source_message_id || 0) : afterMessageId;
    return res.status(200).json({
      ok: results.every((x) => x.ok),
      session: compactSession(loaded.session),
      start_source_message_id: startMessageId || null,
      processed: results.length,
      results,
      next_after_source_message_id: lastProcessed || null,
      remaining_candidates_before_refresh: Math.max(0, candidates.length - selected.length),
    });
  }

  res.status(200).json({
    ok: true,
    service: 'telebots-abangrenderofficial',
    build: 'format-learning-v1-kl-chat',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    adminConfigured: Boolean(process.env.ADMIN_TELEGRAM_ID),
    supabaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    aiConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY),
    setupSecretConfigured: Boolean(process.env.SETUP_SECRET),
    aiProvider: process.env.OPENROUTER_API_KEY ? 'multi-provider' : (process.env.GEMINI_API_KEY ? 'gemini' : null),
    aiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    agentModel: process.env.GEMINI_AGENT_MODEL || 'gemini-2.5-flash-lite',
    agentArchitecture: 'dynamic-toolbox-v1',
    agentToolCount: 51,
    formatLearning: 'per-format-profile-v1',
    aiReplyStyle: 'kuala-lumpur-pasar-chat-bubbles',
  });
}

async function loadLatestBatch() {
  const chatId = Number(process.env.ADMIN_TELEGRAM_ID || 0);
  if (!chatId) throw new Error('ADMIN_TELEGRAM_ID missing');
  const session = await getLatestRecaptionSession(chatId, ['COLLECTING', 'PROCESSING', 'PAUSED', 'COMPLETED', 'FAILED']);
  if (!session) return { session: null, items: [] };
  const items = await listRecaptionSessionItems(chatId, session.id, [], 1000);
  return { session, items };
}

function compactSession(session) {
  return {
    id: session.id,
    status: session.status,
    item_count: session.item_count,
    created_at: session.created_at,
    completed_at: session.completed_at || null,
  };
}

function isLikelyUntranslated(item) {
  const title = String(item?.generated_title || '').trim();
  if (!title) return false;
  return hasNonLatin(title);
}

function hasNonLatin(value) {
  return /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0e00-\u0e7f]/u.test(String(value || ''));
}

function detectSerial(item) {
  const lines = [item?.generated_title, item?.original_caption, item?.file_name]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/\r?\n/))
    .map((value) => value.trim())
    .filter(Boolean);
  const tokens = lines.flatMap((line) => line.match(/[A-Za-z0-9][A-Za-z0-9._-]{4,79}/g) || []);
  return tokens.find(looksLikeSerial) || null;
}

function looksLikeSerial(value) {
  const token = String(value || '').trim();
  return token.length >= 5
    && token.length <= 80
    && !/\s/.test(token)
    && /\d/.test(token)
    && /[A-Za-z._-]/.test(token)
    && !/^https?:/i.test(token)
    && /^[A-Za-z0-9._-]+$/.test(token);
}
