import { hardStop } from '../batch/control.js';
import {
  getLatestRecaptionSession,
  setRecaptionSessionStatus,
} from '../features/recaption-collection.js';
import {
  PIPELINE_REASONS,
  pausePipeline,
} from '../features/pipeline-controller.js';

export const names = ['stop'];

export async function handle({ message, res }) {
  const chatId = message.chat.id;

  await pausePipeline({
    chatId,
    reason: PIPELINE_REASONS.MANUAL_STOP,
    scope: 'chat',
  });

  const session = await getLatestRecaptionSession(chatId, ['PROCESSING']).catch(() => null);
  if (session?.id) {
    await setRecaptionSessionStatus(session.id, 'PAUSED').catch(() => {});
  }

  return hardStop({ chatId, res });
}
