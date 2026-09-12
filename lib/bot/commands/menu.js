import { sendText } from '../core/telegram-client.js';

export const names = ['menu'];

export async function handle({ message, res }) {
  const chatId = message.chat.id;
  const text = [
    '📋 BOT MENU',
    '',
    '🚨 SEND / BATCH',
    '/stop — hard stop semua batch yang tengah jalan',
    '/resume — sambung batch latest yang di-stop',
    '/resetbatch — delete mesej batch latest dari group',
    '',
    'Setiap kali tekan SEND ALL = 1 batch baru yang berasingan.',
    '',
    '📦 QUEUE / FILE',
    '/total — jumlah file + status',
    '/stats — statistik queue',
    '/pending — senarai item belum selesai',
    '/setcaption — set caption/footer global',
    '',
    '🧠 AI / MEMORY',
    '/memories — tengok memory',
    '/remember <ayat> — simpan memory',
    '/forget <id> — buang memory ikut ID',
    '/clearchat — clear chat history AI',
    '/aitest — test sambungan Gemini',
    '',
    '🔧 SYSTEM',
    '/connect — set destination (guna dalam group target)',
    '/whoami — tengok Telegram user ID',
    '/version — tengok build live',
    '/help — bantuan penggunaan bot',
    '/menu — buka menu ni semula',
  ].join('\n');

  await sendText(chatId, text);
  return res.status(200).json({ ok: true, command: 'menu' });
}
