import { beginTelegramAccountConnect, cancelTelegramAccountConnect } from '../features/telegram-account.js';

export const names = ['tglogin', 'tgcancel'];

export async function handle({ message, res, command }) {
  if (command.name === 'tgcancel') {
    await cancelTelegramAccountConnect(message.chat.id);
    return res.status(200).json({ ok: true, command: 'tgcancel' });
  }

  await beginTelegramAccountConnect(message.chat.id);
  return res.status(200).json({ ok: true, command: 'tglogin' });
}
