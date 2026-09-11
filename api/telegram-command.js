import controlHandler from './telegram-control.js';
import { telegram, isAdminMessage } from '../lib/telegram.js';

const COMMAND_TEXT = [
  '📋 COMMAND ABANGRENDER.CO BOT',
  '',
  'SEND CONTROL',
  '1. /stopsend — Stop aktiviti hantar media/file ke group. Batch disimpan pada posisi semasa.',
  '2. /resumesend — Sambung baki batch SEND guna versi caption/data terbaru.',
  '',
  'CAPTION CONTROL',
  '3. /stopcaption — Pause auto caption/recaption. Media baru disimpan dulu.',
  '4. /resumecaption — Sambung caption/recaption guna code + setting/tick terbaru.',
  '',
  'QUEUE & STATUS',
  '5. /pending — Tengok item yang masih pending/ready.',
  '6. /total — Jumlah live file/document dalam bot. Photo tak dikira sebagai file.',
  '7. /stats — Statistik queue: sent, pending, failed, skipped dan caption replaced.',
  '',
  'CAPTION & MEMORY',
  '8. /setcaption — Set caption/footer global secara exact.',
  '9. /memories — Tengok long-term memory bot.',
  '10. /remember <ayat> — Simpan memory baru.',
  '11. /forget <id> — Padam memory ikut ID.',
  '12. /clearchat — Clear history chat AI; long-term memory kekal.',
  '',
  'BOT & DEBUG',
  '13. /command — Paparkan semua command ini.',
  '14. /help — Panduan ringkas penggunaan bot.',
  '15. /start — Buka panduan ringkas bot.',
  '16. /version — Check build/version yang sedang live.',
  '17. /aitest — Test sambungan Gemini AI.',
  '18. /whoami — Paparkan Telegram User ID.',
  '',
  'GROUP',
  '19. /connect — Hantar dalam group target untuk jadikan group itu destination SEND.',
  '',
  'LEGACY ALIAS',
  '20. /stop — Alias lama untuk pause SEND. Disyorkan guna /stopsend.',
  '21. /resume — Alias lama untuk sambung SEND. Disyorkan guna /resumesend.',
  '',
  'Nota: EDIT, SEND, SEND ALL, SEND AGAIN dan RECAPTION AGAIN ialah button workflow, bukan slash command.',
].join('\n');

export default async function handler(req, res) {
  if (req.method !== 'POST') return controlHandler(req, res);

  const message = req.body?.message;
  if (
    message?.chat?.type === 'private'
    && isAdminMessage(message)
    && ['/command', '/commands'].includes(String(message.text || '').trim().toLowerCase())
  ) {
    await telegram('sendMessage', {
      chat_id: message.chat.id,
      text: COMMAND_TEXT,
      disable_web_page_preview: true,
    });
    return res.status(200).json({ ok: true, command_list: true });
  }

  return controlHandler(req, res);
}
