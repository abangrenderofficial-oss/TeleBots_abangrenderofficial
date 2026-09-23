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
      configured: providerConfiguration(),
    });
  }

  if (req.query?.batch_scan === '1' && authorizedProbe) {
    try {
      const loaded = await loadLatestBatchDirect();
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
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error).slice(0, 1000),
        configured: {
          admin: Boolean(process.env.ADMIN_TELEGRAM_ID),
          supabase_url: Boolean(process.env.SUPABASE_URL),
          supabase_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
        },
      });
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

async function loadLatestBatchDirect() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const chatId = Number(process.env.ADMIN_TELEGRAM_ID || 0);
  if (!url || !key) throw new Error('Supabase env missing in this deployment');
  if (!chatId) throw new Error('ADMIN_TELEGRAM_ID missing in this deployment');

  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const sessionResponse = await fetch(
    `${url}/rest/v1/recaption_sessions?admin_chat_id=eq.${encodeURIComponent(chatId)}&order=created_at.desc&limit=1&select=*`,
    { headers },
  );
  const sessionText = await sessionResponse.text();
  if (!sessionResponse.ok) throw new Error(`session fetch ${sessionResponse.status}: ${sessionText.slice(0, 500)}`);
  const sessions = sessionText ? JSON.parse(sessionText) : [];
  const session = sessions?.[0] || null;
  if (!session) return { session: null, items: [] };

  const itemsResponse = await fetch(
    `${url}/rest/v1/queue_items?admin_chat_id=eq.${encodeURIComponent(chatId)}&recaption_session_id=eq.${encodeURIComponent(session.id)}&order=source_message_id.asc,created_at.asc&limit=1000&select=*`,
    { headers },
  );
  const itemsText = await itemsResponse.text();
  if (!itemsResponse.ok) throw new Error(`items fetch ${itemsResponse.status}: ${itemsText.slice(0, 500)}`);
  return { session, items: itemsText ? JSON.parse(itemsText) : [] };
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
  return Boolean(title && hasNonLatin(title));
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
