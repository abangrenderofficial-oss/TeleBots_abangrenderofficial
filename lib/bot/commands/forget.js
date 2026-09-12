import { deleteMemory } from '../../store.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['forget'];

export async function handle({ message, res, command }) {
  const id = Number(String(command.args || '').trim());
  if (!Number.isInteger(id) || id <= 0) {
    await sendText(message.chat.id, 'Memory ID tu tak valid.');
    return res.status(200).json({ ok: true, command: 'forget', deleted: false });
  }

  const deleted = await deleteMemory(message.chat.id, id);
  const found = Boolean(deleted?.length);
  await sendText(message.chat.id, found ? `Memory #${id} dah padam.` : `Memory #${id} tak jumpa.`);
  return res.status(200).json({ ok: true, command: 'forget', deleted: found, id });
}
