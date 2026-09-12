import sendAllHandler from './telegram-sendall.js';
import { isAdminMessage } from '../lib/telegram.js';

// Destination must change ONLY through an explicit /connect command.
// Merely adding the bot to another group must never silently overwrite the
// current destination_chat_id.
export default async function handler(req, res) {
  if (req.method !== 'POST') return sendAllHandler(req, res);

  const message = req.body?.message;
  const chat = message?.chat;
  const isGroup = ['group', 'supergroup'].includes(chat?.type);
  const text = String(message?.text || '').trim();
  const connectCommand = /^\/connect(?:@\w+)?(?:\s|$)/i.test(text);
  const botAdded = Array.isArray(message?.new_chat_members)
    && message.new_chat_members.some((member) => member?.is_bot);

  // Swallow bot-added membership events so the legacy handler cannot treat
  // them as a destination switch. Explicit /connect still passes through.
  if (isGroup && isAdminMessage(message) && botAdded && !connectCommand) {
    return res.status(200).json({
      ok: true,
      destination_unchanged: true,
      reason: 'bot_added_without_connect',
    });
  }

  return sendAllHandler(req, res);
}
