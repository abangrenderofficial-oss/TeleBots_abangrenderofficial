import { disconnectTelegramAccount } from '../features/telegram-account.js';

export const names = ['tglogout'];

export async function handle({ message, res }) {
  await disconnectTelegramAccount(message.chat.id);
  return res.status(200).json({ ok: true, command: 'tglogout' });
}
