import { sendText } from '../core/telegram-client.js';

export const names = ['start', 'help'];

export async function handle({ message, res, command }) {
  const chatId = message.chat.id;
  const text = 'Aku AI assistant kau. Sembang je macam biasa, benda luar pasal bot pun boleh tanya.\n\nPreview default: ✏️, SEND dan SEND ALL. Lepas berjaya sent, preview kekal ada ✏️, SEND AGAIN dan SEND ALL.\n\n/stop untuk hentikan aktiviti send secepat mungkin. /resume sambung baki explicit batch yang sama selepas kau betulkan preview.\n\nSetiap format file belajar setting sendiri: Tajuk, No Siri, Translate, Buang #, Tambah Caption dan Remove Word. Remove Word simpan word/ayat wajib buang untuk format tu.\n\n/formats untuk buka semua format yang pernah diset dan betulkan semula setting mana-mana format lama. Perubahan auto-save.\n\n/total untuk kira live semua file/document dalam bot. Gambar/photo tak masuk kiraan file.\n\nBenda exact sama cuma auto-delete kalau benda asal memang dah berjaya SENT ke group.\n\nGroup destination: invite bot, kemudian /connect dalam group sekali.\n\n/version untuk check build yang tengah live.';
  await sendText(chatId, text);
  return res.status(200).json({ ok: true, command: command.name });
}
