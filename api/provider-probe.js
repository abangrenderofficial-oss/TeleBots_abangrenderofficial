import { probeNamedProvider, probeProviderNames } from '../lib/provider-probe.js';

const PROBE_TOKEN = 'ar260924p7';

export default async function handler(req, res) {
  if (req.query?.probe_token !== PROBE_TOKEN) return res.status(404).json({ ok: false });
  const name = String(req.query?.provider || '').trim().toLowerCase();
  if (!name) return res.status(200).json({ ok: true, providers: probeProviderNames() });
  const result = await probeNamedProvider(name);
  return res.status(result.ok ? 200 : 503).json(result);
}
