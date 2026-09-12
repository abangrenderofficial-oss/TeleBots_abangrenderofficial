import { prepareLatestReset } from '../batch/reset.js';

export const names = ['resetbatch'];

export async function handle({ message, res }) {
  return prepareLatestReset({ chatId: message.chat.id, res });
}
