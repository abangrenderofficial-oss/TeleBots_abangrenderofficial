import { BUILD_VERSION } from '../core/constants.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['version'];

export async function handle({ message, res }) {
  await sendText(message.chat.id, `Build: ${BUILD_VERSION}`);
  return res.status(200).json({ ok: true, command: 'version', build: BUILD_VERSION });
}
