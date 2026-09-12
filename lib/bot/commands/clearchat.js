import { clearChatHistory } from '../../store.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['clearchat'];

export async function handle({ message, res }) {
  await clearChatHistory(message.chat.id);
  await sendText(message.chat.id, 'Chat history AI dah clear. Memory lama masih ada.');
  return res.status(200).json({ ok: true, command: 'clearchat' });
}
