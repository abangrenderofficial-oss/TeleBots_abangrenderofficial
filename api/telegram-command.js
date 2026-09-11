import controlHandler from './telegram-control.js';
import { telegram, isAdminMessage } from '../lib/telegram.js';

const COMMAND_TEXT = [
  '📋 COMMAND ABANGRENDER.CO BOT',
  '',
  'GLOBAL CONTROL',
  '1. /stop — STOP semua aktiviti kerja bot: SEND, caption dan recaption. Queue kekal disimpan.',
  '2. /resume — Sambung semula semua aktiviti tergendala guna code, caption dan setting/tick paling latest.',
  '',
  'QUEUE & STATUS',
  '3. /pending — Tengok item yang masih pending/ready.',
  '4. /total — Jumlah live file/document dalam bot. Photo tak dikira sebagai file.',
  '5. /stats — Statistik queue: sent, pending, failed, skipped dan caption replaced.',
  '',
  'CAPTION & MEMORY',
  '6. /setcaption — Set caption/footer global secara exact.',
  '7. /memories — Tengok long-term memory bot.',
  '8. /remember <ayat> — Simpan memory baru.',
  '9. /forget <id> — Padam memory ikut ID.',
  '10. /clearchat — Clear history chat AI; long-term memory kekal.',
  '',
  'BOT & DEBUG',
  '11. /command — Paparkan semua command ini.',
  '12. /help — Panduan ringkas penggunaan bot.',
  '13. /start — Buka panduan ringkas bot.',
  '14. /version — Check build/version yang sedang live.',
  '15. /aitest — Test sambungan Gemini AI.',
  '16. /whoami — Paparkan Telegram User ID.',
  '',
  'GROUP',
  '17. /connect — Hantar dalam group target untuk jadikan group itu destination SEND.',
  '',
  'ADVANCED / OPTIONAL',
  '18. /stopsend — Pause SEND sahaja.',
  '19. /resumesend — Sambung SEND sahaja.',
  '20. /stopcaption — Pause caption/recaption sahaja.',
  '21. /resumecaption — Sambung caption/recaption sahaja.',
  '',
  'Untuk kegunaan biasa, cukup ingat /stop dan /resume.',
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
