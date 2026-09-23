import { setSetting } from '../../store.js';
import { sendFormatManagerList } from '../features/format-manager.js';

export const names = ['formats'];

export async function handle({ message, res }) {
  await setSetting('admin_state', null);
  await sendFormatManagerList(message.chat.id);
  return res.status(200).json({ ok: true, command: 'formats' });
}
