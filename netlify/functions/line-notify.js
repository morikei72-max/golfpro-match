// netlify/functions/line-notify.js
// LINE通知を送信する共通ユーティリティ
// 【2026/4/25 更新】決済後通知を青カード型Flex Messageに変更
//   - お客様情報(お名前・ふりがな・年齢)をコーチ向けカードに表示
//   - お客様向けカードにキャンセルボタン追加
//   - 生年月日から年齢を自動計算

const { createClient } = require('@supabase/supabase-js');

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

const STORE_KEY_TO_NAME = {
  kyoto: 'Golf Create 戸津池店',
};

const REJECTION_REASON_MAP = {
  health: 'コーチの体調不良のため、万全の状態でレッスンをご提供することが難しく、今回は見送らせていただきます',
  schedule: '誠に恐れ入りますが、ご希望の日程でのご対応が難しく、別日程でのご調整をお願いしたく存じます',
  weather: '当日の天候不良が予想されるため、安全とレッスンの品質を考慮し、見送らせていただきます',
};

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

/* ============================================
   【2026/4/25 追加】年齢計算関数
============================================ */
function calcAge(birthDate) {
  if (!birthDate) return null;
  try {
    const birth = new Date(birthDate);
    if (isNaN(birth.getTime())) return null;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    if (age < 0 || age > 150) return null;
    return age;
  } catch (e) {
    return null;
  }
}

/* ===== 定型文テンプレート(テキスト版・互換性維持) ===== */

function buildBookingConfirmedText({ customerName, coachName, lessonType, dateStr, timeStr, storeName, amount }) {
  return (
    `【予約確定のお知らせ】\n\n` +
    `${customerName || 'お客様'}様\n\n` +
    `ご予約が確定しました。\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `コーチ:${coachName || '—'}\n` +
    `種別:${lessonType || '—'}\n` +
    `日時:${dateStr || '—'} ${timeStr || ''}\n` +
    `場所:${storeName || '—'}\n` +
    `金額:¥${Number(amount || 0).toLocaleString()}\n` +
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
    `お客様:${customerName || '—'}\n` +
    `種別:${lessonType || '—'}\n` +
    `日時:${dateStr || '—'} ${timeStr || ''}\n` +
    `場所:${storeName || '—'}\n` +
    `金額:¥${Number(coachAmount || 0).toLocaleString()}\n` +
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
    `お客様:${customerName || '—'}\n` +
    `コーチ:${coachName || '—'}\n` +
    `日時:${dateStr || '—'} ${timeStr || ''}\n` +
    (reason ? `理由:${reason}\n` : '') +
    `━━━━━━━━━━━━━━━\n\n` +
    `— MyCoach`
  );
}

function buildApprovalRequestText({ coachName, customerName, lessonType, dateStr, timeStr, storeName, amount }) {
  return (
    `【承認依頼】\n\n` +
    `${coachName || 'コーチ'}様\n\n` +
    `新しいご予約依頼が届いています。\n\n` +
    `お客様:${customerName || '—'}様\n` +
    `種別:${lessonType || '—'}\n` +
    `日時:${dateStr || '—'} ${timeStr || ''}\n` +
    `場所:${storeName || '—'}\n` +
    `金額:¥${Number(amount || 0).toLocaleString()}\n\n` +
    `LINEで承認/却下をお選びください。`
  );
}

/**
 * コーチへの承認依頼 Flex Message(緑色・承認/却下ボタン付き)
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
 * 却下理由選択ボタン Flex Message(赤色・4ボタン)
 */
function buildRejectionButtonsFlex({ bookingId }) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#B71C1C',
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: '❌ 却下理由を選択',
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
          type: 'text',
          text: 'お客様には丁寧なお詫び文面が自動送信されます。理由を選択してください。',
          size: 'sm',
          color: '#555555',
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
          style: 'secondary',
          action: {
            type: 'postback',
            label: '🤒 体調不良',
            data: `action=reject_reason&booking_id=${bookingId}&reason_code=health`,
            displayText: '理由:体調不良',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: '📆 別の日程を希望',
            data: `action=reject_reason&booking_id=${bookingId}&reason_code=schedule`,
            displayText: '理由:別の日程を希望',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: '🌧 天候不良',
            data: `action=reject_reason&booking_id=${bookingId}&reason_code=weather`,
            displayText: '理由:天候不良',
          },
        },
        {
          type: 'button',
          style: 'primary',
          color: '#555555',
          action: {
            type: 'postback',
            label: '🚫 その他(理由を入力)',
            data: `action=reject_reason&booking_id=${bookingId}&reason_code=other`,
            displayText: '理由:その他(理由を入力します)',
          },
        },
      ],
    },
  };
}

/**
 * 【2026/4/25 新規】
 * コーチ向け 青カード Flex Message(決済完了後の新しいご依頼通知)
 * お客様情報(名前・ふりがな・年齢)を表示
 */
function buildCoachNewBookingFlex({
  coachName,
  customerName,
  customerFurigana,
  customerAge,
  lessonType,
  dateStr,
  timeStr,
  storeName,
  amount,
}) {
  const customerInfoRows = [
    _flexRow('お名前', `${customerName || '—'} 様`),
  ];

  if (customerFurigana) {
    customerInfoRows.push(_flexRow('ふりがな', customerFurigana));
  }

  if (customerAge !== null && customerAge !== undefined) {
    customerInfoRows.push(_flexRow('年齢', `${customerAge}歳`));
  }

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#1565C0',
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: '🎯 新しいご依頼(確定)',
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
          type: 'text',
          text: '【お客様情報】',
          color: '#1565C0',
          weight: 'bold',
          size: 'sm',
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: customerInfoRows,
        },
        {
          type: 'separator',
          margin: 'md',
        },
        {
          type: 'text',
          text: '【レッスン内容】',
          color: '#1565C0',
          weight: 'bold',
          size: 'sm',
          margin: 'md',
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
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
          text: 'ご対応よろしくお願いいたします',
          size: 'sm',
          color: '#555555',
          margin: 'md',
          align: 'center',
        },
      ],
    },
  };
}

/**
 * 【2026/4/25 新規】
 * お客様向け 青カード Flex Message(予約確定のお知らせ+キャンセルボタン)
 */
function buildBookingConfirmedFlex({
  bookingId,
  customerName,
  coachName,
  lessonType,
  dateStr,
  timeStr,
  storeName,
  amount,
}) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#1565C0',
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: '✅ 予約確定のお知らせ',
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
          type: 'text',
          text: `${customerName || 'お客様'}様`,
          weight: 'bold',
          size: 'md',
          color: '#222222',
        },
        {
          type: 'text',
          text: 'ご予約が確定しました。',
          size: 'sm',
          color: '#555555',
          margin: 'sm',
        },
        {
          type: 'separator',
          margin: 'md',
        },
        {
          type: 'text',
          text: '【担当コーチ】',
          color: '#1565C0',
          weight: 'bold',
          size: 'sm',
          margin: 'md',
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            _flexRow('コーチ', coachName || '—'),
          ],
        },
        {
          type: 'separator',
          margin: 'md',
        },
        {
          type: 'text',
          text: '【ご予約内容】',
          color: '#1565C0',
          weight: 'bold',
          size: 'sm',
          margin: 'md',
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
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
          text: '当日よろしくお願いいたします',
          size: 'sm',
          color: '#555555',
          margin: 'md',
          align: 'center',
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
          style: 'secondary',
          action: {
            type: 'postback',
            label: '❌ 予約をキャンセルする',
            data: `action=cancel_booking&booking_id=${bookingId}`,
            displayText: '予約をキャンセルします',
          },
        },
        {
          type: 'text',
          text: '※キャンセル機能は準備中です',
          size: 'xxs',
          color: '#999999',
          align: 'center',
          margin: 'sm',
        },
      ],
    },
  };
}

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

function buildRejectionReasonPromptText() {
  return (
    `却下理由を3文字以上で返信してください。\n` +
    `お客様にも伝わる丁寧な内容をお願いします。\n\n` +
    `※24時間以内にご返信ください。\n` +
    `※返信内容はそのままお客様に送信されます。`
  );
}

function buildRejectionCompleteText({ customerName }) {
  return (
    `却下処理が完了しました。\n\n` +
    `${customerName || 'お客様'}様にお詫びのご連絡をLINEでお送りいたしました。\n\n` +
    `— MyCoach`
  );
}

function buildRejectionNoticeText({ customerName, coachName, dateStr, timeStr, reason }) {
  return (
    `【ご予約につきましてのお詫び】\n\n` +
    `${customerName || 'お客様'}様\n\n` +
    `この度は、MyCoachをご利用いただき誠にありがとうございます。\n\n` +
    `大変申し訳ございませんが、${coachName || 'コーチ'}コーチの都合により、\n` +
    `下記のご予約をお受けすることが叶わなくなりましたこと、\n` +
    `心よりお詫び申し上げます。\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `コーチ:${coachName || '—'}\n` +
    `日時:${dateStr || '—'} ${timeStr || ''}\n` +
    `理由:${reason || '—'}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `せっかくご予約をいただきましたのに、\n` +
    `ご期待に沿えない結果となりましたこと、重ねてお詫び申し上げます。\n\n` +
    `お手数をおかけいたしますが、別のコーチ、または別日程にて\n` +
    `再度ご予約を承れますと幸いでございます。\n\n` +
    `今後ともMyCoachをよろしくお願い申し上げます。\n\n` +
    `— MyCoach`
  );
}

function buildApprovalCompleteText({ customerName, coachName, lessonType, minutes, dateStr, timeStr, amount, paymentUrl }) {
  const minutesStr = minutes ? `${minutes}分` : '—';
  return (
    `【予約承認のお知らせ】\n\n` +
    `${customerName || 'お客様'}様\n\n` +
    `コーチより予約が承認されました。\n` +
    `下記のリンクからお支払いへお進みください。\n\n` +
    `━━━━━━━━━━━━━━━\n` +
    `コーチ:${coachName || '—'}\n` +
    `種別:${lessonType || '—'}\n` +
    `時間:${minutesStr}\n` +
    `日時:${dateStr || '—'} ${timeStr || ''}\n` +
    `金額:¥${Number(amount || 0).toLocaleString()}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `▼お支払いはこちら\n${paymentUrl || ''}\n\n` +
    `— MyCoach`
  );
}

/* ============================================
   notify() 統合関数 - stripe-webhook.js から呼ばれる
============================================ */

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
 * 【2026/4/25 更新】
 * 予約確定時の通知(コーチとお客様両方にFlex Message青カードを送信)
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

  const { data: booking, error: bookingErr } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();

  if (bookingErr || !booking) {
    console.error('[line-notify] booking fetch error:', bookingErr);
    return;
  }

  let coach = null;
  if (booking.coach_id) {
    const { data } = await supabase
      .from('coaches')
      .select('id, name, line_user_id')
      .eq('id', booking.coach_id)
      .maybeSingle();
    coach = data;
  }

  /* 【2026/4/25 更新】
     customers から furigana, birth_date, age も取得 */
  let customer = null;
  const customerKey = booking.customer_id || booking.customer_user_id;
  if (customerKey) {
    const { data } = await supabase
      .from('customers')
      .select('id, name, furigana, age, birth_date, line_user_id')
      .or(`id.eq.${customerKey},user_id.eq.${customerKey}`)
      .maybeSingle();
    customer = data;
  }

  let storeName = '—';
  if (booking.store_id) {
    const { data } = await supabase
      .from('stores')
      .select('name')
      .eq('id', booking.store_id)
      .maybeSingle();
    if (data) storeName = data.name;
  } else if (booking.store_key) {
    storeName = STORE_KEY_TO_NAME[booking.store_key] || booking.store_key;
  }

  const dateStr = booking.booking_date ? formatDateJa(booking.booking_date) : '—';
  const timeStr = booking.booking_time ? booking.booking_time.substring(0, 5) : '';

  const lessonTypeMap = {
    indoor: 'インドアゴルフレッスン',
    round: 'ラウンドレッスン',
    accompany: '同伴ラウンド',
    comp: 'コンペ参加',
    custom: 'コーチ独自プラン',
  };
  const lessonType = lessonTypeMap[booking.lesson_type] || booking.lesson_type || '—';

  const amount = booking.total_price || 0;
  const coachName = coach?.name || booking.coach_name || 'コーチ';
  const customerName = customer?.name || booking.customer_name || 'お客様';
  const customerFurigana = customer?.furigana || null;

  /* 年齢計算:birth_date 優先、なければ age カラムを使用 */
  let customerAge = null;
  if (customer?.birth_date) {
    customerAge = calcAge(customer.birth_date);
  } else if (customer?.age) {
    customerAge = customer.age;
  }

  /* コーチ向け通知(青カード・Flex Message) */
  if (coach?.line_user_id) {
    const coachFlex = buildCoachNewBookingFlex({
      coachName,
      customerName,
      customerFurigana,
      customerAge,
      lessonType,
      dateStr,
      timeStr,
      storeName,
      amount,
    });
    const result = await pushFlexMessage(
      coach.line_user_id,
      `🎯 新しいご依頼(確定) - ${customerName}様 / ${dateStr}`,
      coachFlex
    );
    console.log('[line-notify] coach flex push:', result);
  } else {
    console.log('[line-notify] coach has no line_user_id');
  }

  /* お客様向け通知(青カード・Flex Message+キャンセルボタン) */
  if (customer?.line_user_id) {
    const customerFlex = buildBookingConfirmedFlex({
      bookingId,
      customerName,
      coachName,
      lessonType,
      dateStr,
      timeStr,
      storeName,
      amount,
    });
    const result = await pushFlexMessage(
      customer.line_user_id,
      `✅ 予約確定のお知らせ - ${coachName} / ${dateStr}`,
      customerFlex
    );
    console.log('[line-notify] customer flex push:', result);
  } else {
    console.log('[line-notify] customer has no line_user_id');
  }
}

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
  buildRejectionButtonsFlex,
  buildRejectionReasonPromptText,
  buildRejectionCompleteText,
  buildRejectionNoticeText,
  buildApprovalCompleteText,
  buildCoachNewBookingFlex,
  buildBookingConfirmedFlex,
  calcAge,
  notify,
  formatDateJa,
  REJECTION_REASON_MAP,
};
