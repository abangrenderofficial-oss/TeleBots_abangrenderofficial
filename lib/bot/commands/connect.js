import { setSetting } from '../../store.js';
import { isAdminMessage } from '../core/auth.js';
import { parseCommand } from '../core/command.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['connect'];

export function matchesGroupEvent(message) {
  if (!['group', 'supergroup'].includes(message?.chat?.type)) return false;
  if (!isAdminMessage(message)) return false;

  const command = parseCommand(message.text);
  const connectCommand = command?.name === 'connect';
  const botAdded = Array.isArray(message.new_chat_members)
    && message.new_chat_members.some((member) => member?.is_bot);
  return Boolean(connectCommand || botAdded);
}

export async function handleGroupEvent({ message, res }) {
  const command = parseCommand(message.text);
  const connectCommand = command?.name === 'connect';
  const chat = message.chat;
  const destination = String(chat.id);

  await setSetting('destination_chat_id', destination);
  await setSetting('destination_chat_info', {
    id: destination,
    title: chat.title || null,
    type: chat.type || null,
    connected_at: new Date().toISOString(),
    connected_by: message.from?.id || null,
    method: connectCommand ? 'connect_command' : 'bot_added',
  });

  if (connectCommand) await sendText(chat.id, 'Connected. Group ni dah jadi destination SEND.');
  return res.status(200).json({ ok: true, command: 'connect', destination });
}
