const SYSTEM = 'Translate the supplied product/model title to natural English. Preserve brand names, model numbers, product codes, software names, and version numbers exactly. If already natural English, return unchanged. Return only the translated title.';

export async function translateTitleFailover(title) {
  const input = String(title || '').trim();
  if (!input) return { text: '', provider: null, model: null, attempts: [] };

  const attempts = [];
  const providers = [
    {
      name: 'openrouter',
      key: String(process.env.OPENROUTER_API_KEY || '').trim(),
      url: 'https://openrouter.ai/api/v1/chat/completions',
      models: ['openrouter/free'],
      timeout: 10000,
    },
    {
      name: 'groq',
      key: String(process.env.GROQ_API_KEY || '').trim(),
      url: 'https://api.groq.com/openai/v1/chat/completions',
      models: ['llama-3.1-8b-instant', 'qwen/qwen3.6-27b'],
      timeout: 8000,
    },
  ];

  for (const provider of providers) {
    if (!provider.key) continue;
    for (const model of provider.models) {
      const result = await callChat(provider, model, input);
      attempts.push({ provider: provider.name, model, ...result.meta });
      if (result.text) {
        return { text: clean(result.text), provider: provider.name, model, attempts };
      }
    }
  }

  const geminiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].map((x) => String(x || '').trim()).filter(Boolean);

  for (let i = 0; i < geminiKeys.length; i += 1) {
    const result = await callGemini(geminiKeys[i], input);
    attempts.push({ provider: `gemini${i + 1}`, model: result.model, ...result.meta });
    if (result.text) {
      return { text: clean(result.text), provider: `gemini${i + 1}`, model: result.model, attempts };
    }
  }

  throw new Error(`Translation unavailable: ${attempts.map((x) => `${x.provider}/${x.model}: ${x.error || x.status || 'failed'}`).join(' | ').slice(0, 1600)}`);
}

export async function probeTranslationFailover() {
  try {
    const result = await translateTitleFailover('现代简约餐椅');
    return { ok: true, provider: result.provider, model: result.model, output: result.text, attempts: result.attempts };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 1800) };
  }
}

async function callChat(provider, model, input) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), provider.timeout);
    const response = await fetch(provider.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${provider.key}`,
        'content-type': 'application/json',
        ...(provider.name === 'openrouter' ? {
          'HTTP-Referer': 'https://tele-bots-abangrenderofficial.vercel.app',
          'X-Title': 'Abang Render Recaption Bot',
        } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: input },
        ],
        temperature: 0,
        max_tokens: 100,
        stream: false,
      }),
    }).finally(() => clearTimeout(timer));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { text: '', meta: { ok: false, status: response.status, error: errorText(data), elapsed_ms: Date.now() - started } };
    }
    const text = data?.choices?.[0]?.message?.content;
    return {
      text: typeof text === 'string' ? text : '',
      meta: { ok: Boolean(text), status: response.status, error: text ? null : 'empty response', elapsed_ms: Date.now() - started },
    };
  } catch (error) {
    return { text: '', meta: { ok: false, error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error), elapsed_ms: Date.now() - started } };
  }
}

async function callGemini(key, input) {
  const models = ['gemini-3.5-flash-lite', 'gemini-3.6-flash'];
  const errors = [];
  const started = Date.now();
  for (const model of models) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json', 'Api-Revision': '2026-05-20' },
        body: JSON.stringify({ model, system_instruction: SYSTEM, input }),
      }).finally(() => clearTimeout(timer));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        errors.push(`${model}: ${errorText(data) || `HTTP ${response.status}`}`);
        continue;
      }
      const text = geminiText(data);
      if (text) return { text, model, meta: { ok: true, status: response.status, elapsed_ms: Date.now() - started } };
      errors.push(`${model}: empty response`);
    } catch (error) {
      errors.push(`${model}: ${error?.name === 'AbortError' ? 'timeout' : String(error?.message || error)}`);
    }
  }
  return { text: '', model: models[0], meta: { ok: false, error: errors.join(' | ').slice(0, 700), elapsed_ms: Date.now() - started } };
}

function geminiText(data) {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  const a = steps.flatMap((step) => Array.isArray(step?.content) ? step.content : []).filter((p) => p?.type === 'text').map((p) => p.text || '').join('').trim();
  if (a) return a;
  return (Array.isArray(data?.outputs) ? data.outputs : []).filter((p) => p?.type === 'text').map((p) => p.text || '').join('').trim();
}

function clean(value) {
  return String(value || '').replace(/^```(?:text)?\s*/i, '').replace(/```$/i, '').replace(/^(?:translation|translated title|title)\s*:\s*/i, '').trim().slice(0, 220);
}

function errorText(data) {
  return data?.error?.message || data?.message || data?.detail || null;
}
