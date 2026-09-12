import { stats } from '../../store.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['stats'];

export async function handle({ message, res }) {
  const s = await stats();
  const text = [
    `Total file: ${s.total}`,
    `Sent: ${s.sent}`,
    `Pending: ${s.pending}`,
    `Failed: ${s.failed}`,
    `Skipped: ${s.skipped || 0}`,
    `Caption replaced: ${s.caption_replaced}`,
    '',
    'Photo/image tak masuk total file utama.',
  ].join('\n');
  await sendText(message.chat.id, text);
  return res.status(200).json({ ok: true, command: 'stats' });
}
