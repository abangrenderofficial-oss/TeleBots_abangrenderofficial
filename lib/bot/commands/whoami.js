import { sendText } from '../core/telegram-client.js';

export const names = ['whoami'];
export const adminOnly = false;

export async function handle({ message, res }) {
  await sendText(message.chat.id, `Telegram User ID: ${message.from?.id ?? 'unknown'}`);
  return res.status(200).json({ ok: true, command: 'whoami' });
}
