import { getSetting, setSetting } from '../../store.js';

const CALLBACK_DEBUG_KEY = 'telegram_callback_debug';

export async function debugCallback(stage, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    stage,
    ...details,
  };

  try {
    const current = await getSetting(CALLBACK_DEBUG_KEY);
    const events = Array.isArray(current?.events) ? current.events : [];
    await setSetting(CALLBACK_DEBUG_KEY, {
      last: entry,
      events: [...events, entry].slice(-30),
    });
  } catch (error) {
    console.error('Callback debug write failed:', error?.message || error);
  }
}
