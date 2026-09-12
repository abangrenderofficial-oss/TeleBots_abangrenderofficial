import { listMemories } from '../../store.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['memories'];

export async function handle({ message, res }) {
  const memories = await listMemories(message.chat.id, 30);
  if (!memories?.length) {
    await sendText(message.chat.id, 'Belum ada long-term memory.');
    return res.status(200).json({ ok: true, command: 'memories', count: 0 });
  }

  const body = memories.map((m) => `#${m.id} — ${m.content}`).join('\n\n').slice(0, 3800);
  await sendText(message.chat.id, `Memory aku sekarang:\n\n${body}`);
  return res.status(200).json({ ok: true, command: 'memories', count: memories.length });
}
