import { listPending } from '../../store.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['pending'];

export async function handle({ message, res }) {
  const items = await listPending(20);
  if (!items.length) {
    await sendText(message.chat.id, 'Tak ada item pending.');
    return res.status(200).json({ ok: true, command: 'pending', count: 0 });
  }

  const body = items
    .map((item, i) => `${i + 1}. ${item.file_name || item.generated_title || 'Untitled'} — ${item.status}`)
    .join('\n');
  await sendText(message.chat.id, `Pending sekarang (${items.length})\n\n${body}`.slice(0, 3900));
  return res.status(200).json({ ok: true, command: 'pending', count: items.length });
}
