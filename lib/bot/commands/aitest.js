import { testGeminiConnection } from '../../assistant.js';
import { sendText } from '../core/telegram-client.js';

export const names = ['aitest'];

export async function handle({ message, res }) {
  const chatId = message.chat.id;
  await sendText(chatId, 'Aku test Gemini jap...');
  const result = await testGeminiConnection();
  await sendText(chatId, formatResult(result));
  return res.status(200).json({ ok: true, command: 'aitest', ai_ok: Boolean(result?.ok) });
}

function formatResult(result) {
  if (result?.ok) {
    return `Gemini OK\nModel: ${result.model}\n${result.ms}ms\nReply: ${result.answer}`;
  }
  if (result?.error) return `Gemini test gagal\n${result.error}`;
  const attempts = (result?.attempts || [])
    .map((x) => `• ${x.model}: ${x.error} (${x.ms}ms)`)
    .join('\n');
  return `Gemini test gagal semua model.\n\n${attempts || 'Tak ada detail.'}`.slice(0, 3900);
}
