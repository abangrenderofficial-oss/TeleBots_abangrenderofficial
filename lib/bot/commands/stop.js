import { hardStop } from '../batch/control.js';

export const names = ['stop'];

export async function handle({ message, res }) {
  return hardStop({ chatId: message.chat.id, res });
}
