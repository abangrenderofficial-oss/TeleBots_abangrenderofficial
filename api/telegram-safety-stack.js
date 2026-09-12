import safetyHandler from './telegram-safety.js';
import { isAdminMessage } from '../lib/telegram.js';

// Keep the destination protection in front of the new caption/sent-message
// safety layer. Adding the bot to another group must never switch destination;
// only an explicit /connect is allowed through.
export default async function handler(req, res) {
  if (req.method !== 'POST') return safetyHandler(req, res);

  const message = req.body?.message;
  const chat = message?.chat;
  const isGroup = ['group', 'supergroup'].includes(chat?.type);
  const text = String(message?.text || '').trim();
  const connectCommand = /^\/connect(?:@\w+)?(?:\s|$)/i.test(text);
  const botAdded = Array.isArray(message?.new_chat_members)
    && message.new_chat_members.some((member) => member?.is_bot);

  if (isGroup && isAdminMessage(message) && botAdded && !connectCommand) {
    return res.status(200).json({
      ok: true,
      destination_unchanged: true,
      reason: 'bot_added_without_connect',
    });
  }

  return safetyHandler(req, res);
}
