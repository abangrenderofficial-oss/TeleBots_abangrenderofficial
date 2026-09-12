import { addMemory } from '../../store.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['remember'];

export async function handle({ message, res, command }) {
  const memory = String(command.args || '').trim();
  if (!memory) {
    await sendText(message.chat.id, 'Guna /remember <ayat>.');
    return res.status(200).json({ ok: true, command: 'remember', saved: false });
  }

  const saved = await addMemory(message.chat.id, memory);
  await sendText(message.chat.id, `Okay, aku ingat. Memory #${saved.id} dah simpan.`);
  return res.status(200).json({ ok: true, command: 'remember', saved: true, id: saved.id });
}
