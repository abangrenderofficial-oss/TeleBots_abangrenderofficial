import { setSetting } from '../../store.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['setcaption'];

export async function handle({ message, res }) {
  await setSetting('admin_state', { mode: 'SET_CAPTION' });
  await sendText(message.chat.id, 'Send caption/footer exact macam kau nak. Hidden link, bold, italic aku simpan sekali.');
  return res.status(200).json({ ok: true, command: 'setcaption' });
}
