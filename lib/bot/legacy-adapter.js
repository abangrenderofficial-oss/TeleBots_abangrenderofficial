import legacyHandler from '../../api/telegram.js';

export async function runLegacySafely(req, res) {
  const shadow = createShadowResponse();
  await legacyHandler(req, shadow).catch((error) => {
    shadow.status(200).json({
      ok: true,
      handled: false,
      legacy_error: String(error?.message || error).slice(0, 500),
    });
  });

  for (const [name, value] of Object.entries(shadow.headers || {})) {
    try { res.setHeader(name, value); } catch {}
  }
  return res.status(shadow.statusCode || 200).json(shadow.body ?? { ok: true });
}

function createShadowResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    end(value) {
      this.body = value;
      return this;
    },
  };
}
