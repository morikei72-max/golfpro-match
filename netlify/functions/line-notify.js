// netlify/functions/line-notify.js
// LINE通知を送信する共通ユーティリティ
// 他のNetlify関数（stripe-webhook.js等）から呼び出して使う
//
// 使い方：
//   const { pushMessage } = require('./line-notify');
//   await pushMessage(lineUserId, 'ご予約が確定しました');

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

/**
 * 指定のLINE userIdにテキストメッセージを送信
 * @param {string} toUserId - LINE user ID (Uxxxxxxxxxx...)
 * @param {string} text - 送信するテキスト（5000文字以内）
 */
async function pushMessage(toUserId, text) {
  if (!toUserId) {
    console.log('[line-notify] skip: no userId');
    return { ok: false, skipped: true };
  }

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.error('[line-notify] LINE_CHANNEL_ACCESS_TOKEN not set');
    return { ok: false, error: 'no_token' };
  }

  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: toUserId,
        messages: [{ type: 'text', text: text.substring(0, 5000) }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[line-notify] push failed:', res.status, errText);
      return { ok: false, status: res.status, error: errText };
    }

    return { ok: true };
  } catch (err) {
    console.error('[line-notify] push error:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * 複数人に同じメッセージを送る（multicast）
 * @param {string[]} toUserIds
 * @param {string} text
 */
async function multicastMessage(toUserIds, text) {
  const ids = (toUserIds || []).filter(Boolean);
  if (ids.length === 0) return { ok: false, skipped: true };

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'no_token' };

  try {
    const res = await fetch('https://api.line.me/v2/bot/message/multicast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: ids,
        messages: [{ type: 'text', text: text.substring(0, 5000) }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('[line-notify] multicast failed:', res.status, errText);
      return { ok: false, status: res.status, error: errText };
    }
    return { ok: true };
  } catch (err) {
    console.error('[line-notify] multicast error:', err);
    return { ok: false, error: err.message };
  }
}

/* ===== 定型文テンプレート =====
   呼び出し例:
     await pushMessage(uid, buildBookingConfirmedText({...}));
*/

function buildBookingConfirmedText({ customerName, coachName, lessonType, dateStr, timeStr, storeName, amount }) {
  return (
    `【予約確定のお知らせ】\n\n` +
    `${customerName || 'お客様'}様\n\n` +
    `ご予約が確定しました。\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `コーチ：${coachName || '—'}\n` +
    `種別：${lessonType || '—'}\n` +
    `日時：${dateStr || '—'} ${timeStr || ''}\n` +
    `場所：${storeName || '—'}\n` +
    `金額：¥${Number(amount || 0).toLocaleString()}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `当日よろしくお願いいたします。\n` +
    `— MyCoach`
  );
}

function buildPaymentCompletedText({ customerName, amount }) {
  return (
    `【お支払い完了】\n\n` +
    `${customerName || 'お客様'}様\n\n` +
    `¥${Number(amount || 0).toLocaleString()} のお支払いが完了しました。\n\n` +
    `ご利用ありがとうございます。\n` +
    `— MyCoach`
  );
}

function buildCoachNewBookingText({ coachName, customerName, lessonType, dateStr, timeStr, storeName, coachAmount }) {
  return (
    `【新しいご依頼】\n\n` +
    `${coachName || 'コーチ'}様\n\n` +
    `新しいレッスン依頼が確定しました。\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `お客様：${customerName || '—'}\n` +
    `種別：${lessonType || '—'}\n` +
    `日時：${dateStr || '—'} ${timeStr || ''}\n` +
    `場所：${storeName || '—'}\n` +
    `手取り：¥${Number(coachAmount || 0).toLocaleString()}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `ご対応よろしくお願いいたします。\n` +
    `— MyCoach`
  );
}

function buildCancellationText({ customerName, coachName, dateStr, timeStr, reason }) {
  return (
    `【キャンセルのお知らせ】\n\n` +
    `以下の予約がキャンセルされました。\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `お客様：${customerName || '—'}\n` +
    `コーチ：${coachName || '—'}\n` +
    `日時：${dateStr || '—'} ${timeStr || ''}\n` +
    (reason ? `理由：${reason}\n` : '') +
    `━━━━━━━━━━━━━━━\n\n` +
    `— MyCoach`
  );
}

module.exports = {
  pushMessage,
  multicastMessage,
  buildBookingConfirmedText,
  buildPaymentCompletedText,
  buildCoachNewBookingText,
  buildCancellationText,
};
