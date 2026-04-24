// netlify/functions/line-notify.js
// LINE通知を送信する共通ユーティリティ
// 他のNetlify関数（stripe-webhook.js等）から呼び出して使う
//
// 使い方：
//   const { pushMessage, notify } = require('./line-notify');
//   await notify('booking_confirmed', { bookingId, session });

const { createClient } = require('@supabase/supabase-js');

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

/**
 * store_key から正式店舗名へのマッピング
 * 【2026/4/20 追加】LINE通知で「場所：kyoto」と表示される問題を解消
 * bookings.store_id が NULL の場合でも、store_key から正式名称を引けるようにする
 */
const STORE_KEY_TO_NAME = {
  kyoto: 'Golf Create 戸津池店',
};

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

/**
 * 【2026/4/24 追加】
 * Flex Messageを送信（承認ボタン付き等のリッチメッセージ）
 * @param {string} toUserId - LINE user ID
 * @param {string} altText - 通知一覧に表示されるテキスト（〜400文字）
 * @param {object} flexContent - Flex Message の contents オブジェクト
 */
async function pushFlexMessage(toUserId, altText, flexContent) {
  if (!toUserId) {
    console.log('[line-notify] flex skip: no userId');
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
        messages: [{
          type: 'flex',
          altText: (altText || '新しい通知').substring(0, 400),
          contents: flexContent,
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[line-notify] flex push failed:', res.status, errText);
      return { ok: false, status: res.status, error: errText };
    }

    return { ok: true };
  } catch (err) {
    console.error('[line-notify] flex push error:', err);
    return { ok: false, error: err.message };
  }
}

/* ===== 定型文テンプレート ===== */

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
    `金額：¥${Number(coachAmount || 0).toLocaleString()}\n` +
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

/**
 * 【2026/4/24 追加】
 * コーチへの承認依頼メッセージ（テキスト、altText用）
 */
function buildApprovalRequestText({ coachName, customerName, lessonType, dateStr, timeStr, storeName, amount }) {
  return (
    `【承認依頼】\n\n` +
    `${coachName || 'コーチ'}様\n\n` +
    `新しいご予約依頼が届いています。\n\n` +
    `お客様：${customerName || '—'}様\n` +
    `種別：${lessonType || '—'}\n` +
    `日時：${dateStr || '—'} ${timeStr || ''}\n` +
    `場所：${storeName || '—'}\n` +
    `金額：¥${Number(amount || 0).toLocaleString()}\n\n` +
    `LINEで承認／却下をお選びください。`
  );
}

/**
 * 【2026/4/24 追加】
 * コーチへの承認依頼 Flex Message（承認／却下ボタン付き）
 * postbackで「approve_booking:{bookingId}」「reject_booking:{bookingId}」が返る
 */
function buildApprovalRequestFlex({ bookingId, customerName, lessonType, dateStr, timeStr, storeName, amount }) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#2E7D32',
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: '🏌 新しいご予約依頼',
          color: '#FFFFFF',
          weight: 'bold',
          size: 'lg',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            _flexRow('お客様', `${customerName || '—'} 様`),
            _flexRow('種別', lessonType || '—'),
            _flexRow('日時', `${dateStr || '—'} ${timeStr || ''}`.trim()),
            _flexRow('場所', storeName || '—'),
            _flexRow('金額', `¥${Number(amount || 0).toLocaleString()}`),
          ],
        },
        {
          type: 'separator',
          margin: 'lg',
        },
        {
          type: 'text',
          text: '下のボタンから承認または却下してください',
          size: 'xs',
          color: '#888888',
          margin: 'md',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#2E7D32',
          action: {
            type: 'postback',
            label: '✅ 承認する',
            data: `action=approve_booking&booking_id=${bookingId}`,
            displayText: '予約を承認しました',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: '❌ 却下する',
            data: `action=reject_booking&booking_id=${bookingId}`,
            displayText: '予約を却下します',
          },
        },
      ],
    },
  };
}

/**
 * Flex Message の1行（ラベル：値）
 */
function _flexRow(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      {
        type: 'text',
        text: label,
        color: '#666666',
        size: 'sm',
        flex: 2,
      },
      {
        type: 'text',
        text: String(value || '—'),
        wrap: true,
        color: '#222222',
        size: 'sm',
        flex: 5,
      },
    ],
  };
}

/**
 * 【2026/4/24 追加】
 * コーチへの却下理由入力依頼メッセージ
 */
function buildRejectionReasonPromptText() {
  return (
    `却下の理由を3文字以上で返信してください。\n` +
    `お客様にも伝わる内容をお願いします。\n\n` +
    `例：\n` +
    `・その時間は別のご予約が入っています\n` +
    `・体調不良のため対応できません\n` +
    `・別の日程でお願いします\n\n` +
    `※10分以内にご返信ください`
  );
}

/**
 * 【2026/4/24 追加】
 * コーチへの却下完了メッセージ
 */
function buildRejectionCompleteText({ customerName }) {
  return (
    `却下しました。\n` +
    `${customerName || 'お客様'}様にLINEでご連絡済みです。\n` +
    `— MyCoach`
  );
}

/**
 * 【2026/4/24 追加】
 * お客様への却下通知メッセージ
 */
function buildRejectionNoticeText({ customerName, coachName, dateStr, timeStr, reason }) {
  return (
    `【ご予約についてのご連絡】\n\n` +
    `${customerName || 'お客様'}様\n\n` +
    `申し訳ございません。\n` +
    `コーチの都合により、以下のご予約がお受けできませんでした。\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `コーチ：${coachName || '—'}\n` +
    `日時：${dateStr || '—'} ${timeStr || ''}\n` +
    `理由：${reason || '—'}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `他のコーチ・日程でぜひお試しください。\n` +
    `— MyCoach`
  );
}

/**
 * 【2026/4/24 追加】
 * お客様への承認完了＆決済案内メッセージ
 */
function buildApprovalCompleteText({ customerName, coachName, dateStr, timeStr, amount, paymentUrl }) {
  return (
    `【予約承認のお知らせ】\n\n` +
    `${customerName || 'お客様'}様\n\n` +
    `コーチより予約が承認されました。\n` +
    `下記のリンクからお支払いへお進みください。\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `コーチ：${coachName || '—'}\n` +
    `日時：${dateStr || '—'} ${timeStr || ''}\n` +
    `金額：¥${Number(amount || 0).toLocaleString()}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `▼お支払いはこちら\n${paymentUrl || ''}\n\n` +
    `— MyCoach`
  );
}

/* ============================================
   notify() 統合関数 - stripe-webhook.js から呼ばれる
============================================ */

/**
 * イベント種別に応じてLINE通知を送る
 * @param {string} kind - 'booking_confirmed' | 'booking_cancelled' | etc.
 * @param {object} payload - { bookingId, session, ... }
 */
async function notify(kind, payload) {
  try {
    if (kind === 'booking_confirmed') {
      await notifyBookingConfirmed(payload);
    } else {
      console.log('[line-notify] unknown kind:', kind);
    }
  } catch (e) {
    console.error('[line-notify] notify error:', e);
  }
}

/**
 * 予約確定時の通知（コーチとお客様両方に送信）
 */
async function notifyBookingConfirmed({ bookingId, session }) {
  if (!bookingId) {
    console.log('[line-notify] no bookingId');
    return;
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // 予約情報を取得
  const { data: booking, error: bookingErr } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();

  if (bookingErr || !booking) {
    console.error('[line-notify] booking fetch error:', bookingErr);
    return;
  }

  // コーチ情報を取得
  let coach = null;
  if (booking.coach_id) {
    const { data } = await supabase
      .from('coaches')
      .select('id, name, line_user_id')
      .eq('id', booking.coach_id)
      .maybeSingle();
    coach = data;
  }

  // お客様情報を取得（customer_id または customer_user_id で）
  let customer = null;
  const customerKey = booking.customer_id || booking.customer_user_id;
  if (customerKey) {
    const { data } = await supabase
      .from('customers')
      .select('id, name, line_user_id')
      .or(`id.eq.${customerKey},user_id.eq.${customerKey}`)
      .maybeSingle();
    customer = data;
  }

  // 店舗情報（任意）
  // 【2026/4/20 修正】store_key から正式店舗名に変換するロジックを追加
  // 変更前：storeName = booking.store_key; // 'kyoto' がそのまま表示されていた
  // 変更後：STORE_KEY_TO_NAME マップを引いて正式名称を取得
  let storeName = '—';
  if (booking.store_id) {
    const { data } = await supabase
      .from('stores')
      .select('name')
      .eq('id', booking.store_id)
      .maybeSingle();
    if (data) storeName = data.name;
  } else if (booking.store_key) {
    // store_key → 正式店舗名 への変換
    storeName = STORE_KEY_TO_NAME[booking.store_key] || booking.store_key;
  }

  // 日時フォーマット
  const dateStr = booking.booking_date
    ? formatDateJa(booking.booking_date)
    : '—';
  const timeStr = booking.booking_time
    ? booking.booking_time.substring(0, 5)
    : '';

  // レッスン種別
  const lessonTypeMap = {
    indoor: 'インドアゴルフレッスン',
    round: 'ラウンドレッスン',
    accompany: '同伴ラウンド',
    comp: 'コンペ参加',
  };
  const lessonType = lessonTypeMap[booking.lesson_type] || booking.lesson_type || '—';

  const amount = booking.total_price || 0;
  const coachName = coach?.name || booking.coach_name || 'コーチ';
  const customerName = customer?.name || booking.customer_name || 'お客様';

  // コーチへLINE通知
  if (coach?.line_user_id) {
    const coachText = buildCoachNewBookingText({
      coachName,
      customerName,
      lessonType,
      dateStr,
      timeStr,
      storeName,
      coachAmount: amount,
    });
    const result = await pushMessage(coach.line_user_id, coachText);
    console.log('[line-notify] coach push:', result);
  } else {
    console.log('[line-notify] coach has no line_user_id');
  }

  // お客様へLINE通知
  if (customer?.line_user_id) {
    const customerText = buildBookingConfirmedText({
      customerName,
      coachName,
      lessonType,
      dateStr,
      timeStr,
      storeName,
      amount,
    });
    const result = await pushMessage(customer.line_user_id, customerText);
    console.log('[line-notify] customer push:', result);
  } else {
    console.log('[line-notify] customer has no line_user_id');
  }
}

/**
 * 日付を日本語フォーマットに (例: 2026年4月22日(水))
 */
function formatDateJa(dateStr) {
  if (!dateStr) return '—';
  const parts = String(dateStr).split('-');
  if (parts.length < 3) return dateStr;
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];
  return (
    parts[0] + '年' +
    parseInt(parts[1], 10) + '月' +
    parseInt(parts[2], 10) + '日(' +
    weekdayNames[d.getDay()] + ')'
  );
}

module.exports = {
  pushMessage,
  multicastMessage,
  pushFlexMessage,
  buildBookingConfirmedText,
  buildPaymentCompletedText,
  buildCoachNewBookingText,
  buildCancellationText,
  buildApprovalRequestText,
  buildApprovalRequestFlex,
  buildRejectionReasonPromptText,
  buildRejectionCompleteText,
  buildRejectionNoticeText,
  buildApprovalCompleteText,
  notify,
  formatDateJa,
};
