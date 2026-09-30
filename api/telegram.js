// Compatibility alias only. All live Telegram traffic must use the same isolated
// router so an old webhook URL can never revive the historical monolith.
export { default } from './telegram-safe-destination.js';
