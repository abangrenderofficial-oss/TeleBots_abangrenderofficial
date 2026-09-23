import {
  getFormatProfile,
  listFormatProfiles,
} from '../../format-profiles.js';
import {
  getFormatRemoveTerms,
  removeWordButtonLabel,
} from '../../remove-words.js';
import { telegram, inlineKeyboard } from '../../telegram.js';

const PAGE_SIZE = 12;

export async function sendFormatManagerList(chatId, options = {}) {
  const profiles = await listFormatProfiles();
  const pageCount = Math.max(1, Math.ceil(profiles.length / PAGE_SIZE));
  const page = clampPage(options.page, pageCount);
  const start = page * PAGE_SIZE;
  const visible = profiles.slice(start, start + PAGE_SIZE);

  const rows = chunkButtons(visible.map((profile) => ({
    text: `${profile.learned ? '✅' : '🧠'} ${profile.name}`,
    callback_data: `fmtmgr_open:${profile.id}`,
  })), 2);

  if (pageCount > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️', callback_data: `fmtmgr_page:${page - 1}` });
    nav.push({ text: `${page + 1}/${pageCount}`, callback_data: 'noop' });
    if (page < pageCount - 1) nav.push({ text: '➡️', callback_data: `fmtmgr_page:${page + 1}` });
    rows.push(nav);
  }

  const text = profiles.length
    ? '🧠 FORMAT MANAGER\n\nPilih mana-mana format lama untuk betulkan setting dia. Semua perubahan auto-save untuk format itu sahaja.\n\n♻️ AJAR SEMULA akan paksa format itu masuk flow review + confirm dua kali pada file matching yang seterusnya.'
    : '🧠 FORMAT MANAGER\n\nBelum ada format yang pernah diset.';

  return renderText(chatId, options.messageId, text, rows);
}

export async function showFormatManager(profileId, chatId, messageId = null) {
  const profile = await getFormatProfile(profileId);
  if (!profile) {
    return renderText(
      chatId,
      messageId,
      'Format tu dah tak jumpa. Buka /formats semula.',
      [[{ text: '⬅️ Semua Format', callback_data: 'fmtmgr_page:0' }]],
    );
  }

  const removeTerms = await getFormatRemoveTerms(profile.id).catch(() => []);
  const on = (value) => (value ? '✅' : '⬜');
  const status = profile.learned
    ? '✅ SET'
    : '🧠 PERLU CONFIRM SEMULA';

  const text = [
    `🧠 ${profile.name}`,
    '',
    `Status: ${status}`,
    'Setting bawah ni milik format ini sahaja. Tekan mana-mana option untuk betulkan; perubahan terus auto-save.',
  ].join('\n');

  const rows = [
    [
      { text: `${on(profile.actions.take_title)} Tajuk`, callback_data: `fmtmgr_title:${profile.id}` },
      { text: `${on(profile.actions.take_serial)} No Siri`, callback_data: `fmtmgr_serial:${profile.id}` },
    ],
    [
      { text: `${on(profile.actions.translate)} Translate`, callback_data: `fmtmgr_translate:${profile.id}` },
      { text: `${on(profile.actions.remove_hashtags)} Buang #`, callback_data: `fmtmgr_hashtags:${profile.id}` },
    ],
    [
      { text: `${on(profile.actions.add_footer)} Tambah Caption`, callback_data: `fmtmgr_footer:${profile.id}` },
      { text: '✏️ Ubah Caption', callback_data: `fmtmgr_editfooter:${profile.id}` },
    ],
    [
      { text: removeWordButtonLabel(removeTerms), callback_data: `fmtmgr_removeword:${profile.id}` },
    ],
    [
      { text: '♻️ AJAR SEMULA FORMAT', callback_data: `fmtmgr_relearn:${profile.id}` },
    ],
    [
      { text: '⬅️ Semua Format', callback_data: 'fmtmgr_page:0' },
    ],
  ];

  return renderText(chatId, messageId, text, rows);
}

export async function showFormatRelearnConfirmation(profileId, chatId, messageId = null) {
  const profile = await getFormatProfile(profileId);
  if (!profile) return sendFormatManagerList(chatId, { messageId });

  const text = [
    `⚠️ AJAR SEMULA ${profile.name}?`,
    '',
    'Setting yang dah ada TAK dipadam. Tapi status learned/confirmed akan dibuka semula.',
    'Bila file yang match format ini masuk lepas ni, bot akan pause, bagi kau betulkan lagi, CONFIRM dua kali, kemudian /resume.',
  ].join('\n');

  return renderText(chatId, messageId, text, [
    [{ text: '✅ YA, AJAR SEMULA', callback_data: `fmtmgr_relearn2:${profile.id}` }],
    [{ text: 'Batal', callback_data: `fmtmgr_open:${profile.id}` }],
  ]);
}

export function formatManagerOptionFromAction(action) {
  const map = {
    fmtmgr_title: 'take_title',
    fmtmgr_serial: 'take_serial',
    fmtmgr_translate: 'translate',
    fmtmgr_hashtags: 'remove_hashtags',
    fmtmgr_footer: 'add_footer',
  };
  return map[action] || null;
}

async function renderText(chatId, messageId, text, rows) {
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: inlineKeyboard(rows),
  };

  if (messageId) {
    try {
      return await telegram('editMessageText', {
        ...payload,
        message_id: messageId,
      });
    } catch (error) {
      const msg = String(error?.message || error);
      if (!/message is not modified/i.test(msg)) {
        console.error('Format manager edit fallback:', msg);
      }
    }
  }

  return telegram('sendMessage', payload);
}

function chunkButtons(buttons, size) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += size) rows.push(buttons.slice(i, i + size));
  return rows;
}

function clampPage(value, pageCount) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), Math.max(0, pageCount - 1));
}
