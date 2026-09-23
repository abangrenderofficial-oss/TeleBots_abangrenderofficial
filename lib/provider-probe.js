const SYSTEM = 'Translate the supplied product/model title faithfully to natural English. Preserve every detail and do not omit, shorten, summarize, or simplify. Preserve brand names, model numbers, product codes, software names, and version numbers exactly. Return only the full translated title.';
const SAMPLE = 'Набор спортивных гантелей и блинов на стойках';

const PROVIDERS = {
  together: {
    keyEnv: 'TOGETHER_API_KEY',
    url: 'https://api.together.xyz/v1/chat/completions',
    models: ['Qwen/Qwen3.5-9B', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  },
  mistral: {
    keyEnv: 'MISTRAL_API_KEY',
    url: 'https://api.mistral.ai/v1/chat/completions',
    models: ['mistral-small-latest'],
  },
  deepseek: {
    keyEnv: 'DEEPSEEK_API_KEY',
    url: 'https://api.deepseek.com/chat/completions',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    modelsUrl: 'https://api.deepseek.com/models',
  },
  cerebras: {
    keyEnv: 'CEREBRAS_API_KEY',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    models: ['gpt-oss-120b'],
  },
  sambanova: {
    keyEnv: 'SAMBANOVA_API_KEY',
    url: 'https://api.sambanova.ai/v1/chat/completions',
    models: ['gpt-oss-120b', 'DeepSeek-V3.2', 'MiniMax-M3', 'Meta-Llama-3.3-70B-Instruct'],
    modelsUrl: 'https://api.sambanova.ai/v1/models',
  },
  upstage: {
    keyEnv: 'UPSTAGE_API_KEY',
    url: 'https://api.upstage.ai/v1/chat/completions',
    models: ['solar-mini4', 'solar-pro4'],
  },
  minimax: {
    keyEnv: 'MINIMAX_API_KEY',
    url: 'https://api.minimax.io/v1/chat/completions',
    models: ['MiniMax-M3', 'MiniMax-M2.7'],
    maxTokens: 700,
  },
};

export async function probeNamedProvider(name, input = SAMPLE) {
  const provider = PROVIDERS[String(name || '').toLowerCase()];
  if (!provider) return { ok: false, provider: name, error: 'unknown provider' };
  const key = String(process.env[provider.keyEnv] || '').trim();
  if (!key) return { ok: false, provider: name, configured: false, error: `${provider.keyEnv} missing` };

  const attempts = [];
  for (const model of provider.models) {
    const result = await callProvider(provider, key, model, input);
    attempts.push({ model, ...result.meta });
    const text = clean(result.text);
    if (text && !hasNonLatin(text)) {
      return { ok: true, provider: name, configured: true, model, output: text, attempts };
    }
  }

  let availableModels = null;
  if (provider.modelsUrl) availableModels = await listModels(provider.modelsUrl, key).catch(() => null);
  return {
    ok: false,
    provider: name,
    configured: true,
    attempts,
    available_models: availableModels,
    error: attempts.map((x) => `${x.model}: ${x.error || x.status || 'failed'}`).join(' | ').slice(0, 1600),
  };
}

export function probeProviderNames() {
  return Object.keys(PROVIDERS);
}

async function callProvider(provider, key, model, input) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(provider.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: input },
        ],
        temperature: 0,
        max_tokens: provider.maxTokens || 220,
        max_completion_tokens: provider.maxTokens || 220,
        stream: false,
      }),
    }).finally(() => clearTimeout(timer));

    const data = await response.json().catch(() => ({}));
    const appError = data?.base_resp?.status_code && Number(data.base_resp.status_code) !== 0
      ? data.base_resp.status_msg || `MiniMax status ${data.base_resp.status_code}`
      : null;
    if (!response.ok || appError) {
      return { text: '', meta: { ok: false, status: response.status, error: appError || errorText(data) || `HTTP ${response.status}`, elapsed_ms: Date.now() - started } };
    }

    const text = extractText(data);
    return {
      text,
      meta: {
        ok: Boolean(text),
        status: response.status,
        error: text ? null : `empty response; keys=${Object.keys(data || {}).slice(0, 12).join(',')}; finish=${data?.choices?.[0]?.finish_reason || 'n/a'}`,
        elapsed_ms: Date.now() - started,
      },
    };
  } catch (error) {
    return { text: '', meta: { ok: false, error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error), elapsed_ms: Date.now() - started } };
  }
}

async function listModels(url, key) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return rows.map((x) => x?.id || x?.model || x?.name).filter(Boolean).slice(0, 80);
}

function extractText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((x) => x?.text || x?.content || '').join('').trim();
  const delta = data?.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') return delta.trim();
  if (typeof data?.reply === 'string') return data.reply.trim();
  if (typeof data?.content === 'string') return data.content.trim();
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  return '';
}

function errorText(data) {
  return data?.error?.message || data?.message || data?.detail || data?.base_resp?.status_msg || null;
}

function clean(value) {
  return String(value || '').replace(/^```(?:text)?\s*/i, '').replace(/```$/i, '').replace(/^(?:translation|translated title|title)\s*:\s*/i, '').trim().slice(0, 400);
}

function hasNonLatin(value) {
  return /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0600-\u06ff\u0e00-\u0e7f]/u.test(String(value || ''));
}
