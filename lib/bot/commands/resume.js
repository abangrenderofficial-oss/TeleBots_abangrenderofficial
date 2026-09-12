import { resumeLatest } from '../batch/control.js';

export const names = ['resume'];

export async function handle({ message, res }) {
  return resumeLatest({ chatId: message.chat.id, res });
}
