import { stats } from '../../store.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['total'];

export async function handle({ message, res }) {
  const s = await stats();
  const text = `TOTAL FILE: ${s.total}\n✅ SENT: ${s.sent}\n⏳ PENDING/READY: ${s.pending}\n❌ FAILED: ${s.failed}\n⏭ SKIPPED: ${s.skipped || 0}\n\nGambar/photo tak dikira sebagai file.`;
  await sendText(message.chat.id, text);
  return res.status(200).json({ ok: true, command: 'total' });
}
