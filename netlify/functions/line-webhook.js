// netlify/functions/line-webhook.js
// LINE公式アカウント「MyCoach」からのWebhookを受け取る
//
// 主な役割：
//   1. 署名検証（セキュリティ）
//   2. 友だち追加/解除イベントの処理
//   3. postback（承認／却下ボタン押下）の処理
//   4. message（却下理由入力）の処理

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const {
  pushMessage,
  pushFlexMessage,
  buildRejectionButtonsFlex,
  buildRejectionReasonPromptText,
  buildRejectionCompleteText,
  buildRejectionNoticeText,
  buildApprovalCompleteText,
  formatDateJa,
  REJECTION_REASON_MAP,
} = require('./line-notify');

// ============================================
// 店舗・レッスン種別マッピング
// ============================================
const STORE_KEY_TO_NAME = {
  kyoto: 'Golf Create 戸津池店',
};

const LESSON_TYPE_LABEL = {
  indoor: 'インドアゴルフレッスン',
  round: 'ラウンドレッスン',
  accompany: '同伴ラウンド',
  comp: 'コンペ参加',
};

// ============================================
// ベースURL（お客様への決済リンク生成に使用）
// ============================================
const BASE_URL = 'https://soft-speculoos-5ef188.netlify.app';

exports.handler = async (event) => {
  // CORS & OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Line-Signature',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Netlifyのbase64対応
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

    // 署名検証
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const signature = event.headers['x-line-signature'] || event.headers['X-Line-Signature'];

    if (channelSecret && signature) {
      const hash = crypto
        .createHmac('sha256', channelSecret)
        .update(rawBody)
        .digest('base64');
      if (hash !== signature) {
        console.error('LINE signature mismatch');
        return { statusCode: 401, body: 'Invalid signature' };
      }
    }

    const body = JSON.parse(rawBody);
    const events = body.events || [];

    // Supabase クライアント（Service Role Key使用）
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ============================================
    // イベントループ
    // ============================================
    for (const ev of events) {
      const lineUserId = ev.source && ev.source.userId;
      if (!lineUserId) continue;

      // ----- 1. 友だち追加 -----
      if (ev.type === 'follow') {
        console.log('New follower:', lineUserId);
      }

      // ----- 2. 友だち解除 -----
      if (ev.type === 'unfollow') {
        console.log('Unfollow:', lineUserId);
        await supabase
          .from('customers')
          .update({ line_user_id: null })
          .eq('line_user_id', lineUserId);
        await supabase
          .from('coaches')
          .update({ line_user_id: null })
          .eq('line_user_id', lineUserId);
      }

      // ----- 3. postback（承認／却下ボタン押下） -----
      if (ev.type === 'postback') {
        await handlePostback({ ev, lineUserId, supabase });
      }

      // ----- 4. message（却下理由入力 or 通常メッセージ） -----
      if (ev.type === 'message' && ev.message?.type === 'text') {
        await handleTextMessage({ ev, lineUserId, supabase });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    console.error('line-webhook error:', err);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};

// ============================================
// postback処理（承認／却下／理由選択）
// ============================================
async function handlePostback({ ev, lineUserId, supabase }) {
  const data = ev.postback?.data || '';
  const params = parseQueryString(data);
  const action = params.action;
  const bookingId = params.booking_id;

  console.log('[postback]', { action, bookingId, lineUserId });

  if (!action || !bookingId) {
    console.warn('[postback] invalid data:', data);
    return;
  }

  if (action === 'approve_booking') {
    await handleApprove({ bookingId, lineUserId, supabase });
    return;
  }

  if (action === 'reject_booking') {
    await handleRejectInit({ bookingId, lineUserId, supabase });
    return;
  }

  if (action === 'reject_reason') {
    const reasonCode = params.reason_code;
    if (reasonCode === 'other') {
      await handleRejectOther({ bookingId, lineUserId, supabase });
    } else {
      await handleRejectWithPresetReason({ bookingId, lineUserId, reasonCode, supabase });
    }
    return;
  }

  console.warn('[postback] unknown action:', action);
}

// ============================================
// 承認処理
// ============================================
async function handleApprove({ bookingId, lineUserId, supabase }) {
  const { error: updateErr } = await supabase
    .from('bookings')
    .update({ status: 'approved_pending_payment' })
    .eq('id', bookingId)
    .eq('status', 'pending_approval');

  if (updateErr) {
    console.error('[approve] update error:', updateErr);
    await pushMessage(lineUserId, '承認処理でエラーが発生しました。お手数ですがコーチ画面からご確認ください。');
    return;
  }

  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();

  if (!booking) {
    console.error('[approve] booking not found:', bookingId);
    return;
  }

  if (booking.status !== 'approved_pending_payment') {
    await pushMessage(lineUserId, 'この予約は既に処理されています。');
    return;
  }

  const { data: coach } = await supabase
    .from('coaches')
    .select('id, name, line_user_id')
    .eq('id', booking.coach_id)
    .maybeSingle();

  const customerKey = booking.customer_id || booking.customer_user_id;
  let customer = null;
  if (customerKey) {
    const { data } = await supabase
      .from('customers')
      .select('id, name, line_user_id')
      .or(`id.eq.${customerKey},user_id.eq.${customerKey}`)
      .maybeSingle();
    customer = data;
  }

  const coachName = coach?.name || booking.coach_name || 'コーチ';
  const customerName = customer?.name || booking.customer_name || 'お客様';
  const dateStr = formatDateJa(booking.booking_date);
  const timeStr = booking.booking_time ? booking.booking_time.substring(0, 5) : '';
  const amount = booking.total_price || 0;
  const paymentUrl = `${BASE_URL}/customer.html?action=pay&booking_id=${bookingId}`;

  // 【2026/4/24 追加】レッスン種別・時間を取得（森下様ご指摘対応）
  const lessonType = LESSON_TYPE_LABEL[booking.lesson_type] || booking.lesson_type || '—';
  const minutes = booking.minutes || null;

  // お客様に決済案内送信
  if (customer?.line_user_id) {
    const customerMsg = buildApprovalCompleteText({
      customerName,
      coachName,
      lessonType,   // ★追加
      minutes,      // ★追加
      dateStr,
      timeStr,
      amount,
      paymentUrl,
    });
    await pushMessage(customer.line_user_id, customerMsg);
    console.log('[approve] customer notified');
  } else {
    console.warn('[approve] customer has no line_user_id');
  }

  // コーチに承認完了通知
  await pushMessage(
    lineUserId,
    `✅ 予約を承認しました。\n\n` +
    `${customerName}様にお支払い案内をLINEでお送りいたしました。\n\n` +
    `— MyCoach`
  );
}

// ============================================
// 却下ボタン押下(理由選択画面表示)
// ============================================
async function handleRejectInit({ bookingId, lineUserId, supabase }) {
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('id', bookingId)
    .maybeSingle();

  if (!booking) {
    await pushMessage(lineUserId, 'この予約が見つかりませんでした。');
    return;
  }

  if (booking.status !== 'pending_approval') {
    await pushMessage(lineUserId, 'この予約は既に処理されています。');
    return;
  }

  const flexContent = buildRejectionButtonsFlex({ bookingId });
  await pushFlexMessage(
    lineUserId,
    '却下理由を選択してください',
    flexContent
  );
}

// ============================================
// 却下理由:定型ボタン選択
// ============================================
async function handleRejectWithPresetReason({ bookingId, lineUserId, reasonCode, supabase }) {
  const reasonText = REJECTION_REASON_MAP[reasonCode];
  if (!reasonText) {
    console.warn('[reject_preset] unknown reason_code:', reasonCode);
    return;
  }

  await finalizeRejection({
    bookingId,
    lineUserId,
    reasonText,
    supabase,
  });
}

// ============================================
// 却下理由:その他(自由入力)
// ============================================
async function handleRejectOther({ bookingId, lineUserId, supabase }) {
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('id', bookingId)
    .maybeSingle();

  if (!booking || booking.status !== 'pending_approval') {
    await pushMessage(lineUserId, 'この予約は既に処理されています。');
    return;
  }

  await supabase
    .from('pending_rejections')
    .delete()
    .eq('coach_line_user_id', lineUserId)
    .eq('booking_id', bookingId);

  const { error: insertErr } = await supabase
    .from('pending_rejections')
    .insert({
      coach_line_user_id: lineUserId,
      booking_id: bookingId,
    });

  if (insertErr) {
    console.error('[reject_other] insert error:', insertErr);
    await pushMessage(lineUserId, '却下処理の開始に失敗しました。もう一度お試しください。');
    return;
  }

  await pushMessage(lineUserId, buildRejectionReasonPromptText());
}

// ============================================
// テキストメッセージ処理(却下理由 or 通常)
// ============================================
async function handleTextMessage({ ev, lineUserId, supabase }) {
  const text = (ev.message.text || '').trim();

  const { data: pending } = await supabase
    .from('pending_rejections')
    .select('*')
    .eq('coach_line_user_id', lineUserId)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pending) {
    await handleRejectionReasonInput({
      pending,
      text,
      lineUserId,
      supabase,
    });
    return;
  }

  console.log('Message from', lineUserId, ':', text);
}

// ============================================
// 却下理由入力の処理
// ============================================
async function handleRejectionReasonInput({ pending, text, lineUserId, supabase }) {
  if (text.length < 3) {
    await pushMessage(
      lineUserId,
      `却下理由は3文字以上で返信してください。\n現在: ${text.length}文字`
    );
    return;
  }

  await finalizeRejection({
    bookingId: pending.booking_id,
    lineUserId,
    reasonText: text,
    supabase,
  });

  await supabase
    .from('pending_rejections')
    .delete()
    .eq('id', pending.id);
}

// ============================================
// 却下処理の共通処理
// ============================================
async function finalizeRejection({ bookingId, lineUserId, reasonText, supabase }) {
  const { error: updateErr } = await supabase
    .from('bookings')
    .update({
      status: 'rejected',
      rejection_reason: reasonText,
    })
    .eq('id', bookingId)
    .eq('status', 'pending_approval');

  if (updateErr) {
    console.error('[finalize_reject] update error:', updateErr);
    await pushMessage(lineUserId, '却下処理でエラーが発生しました。お手数ですがコーチ画面からご確認ください。');
    return;
  }

  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();

  if (!booking) {
    console.error('[finalize_reject] booking not found:', bookingId);
    return;
  }

  const { data: coach } = await supabase
    .from('coaches')
    .select('id, name')
    .eq('id', booking.coach_id)
    .maybeSingle();

  const customerKey = booking.customer_id || booking.customer_user_id;
  let customer = null;
  if (customerKey) {
    const { data } = await supabase
      .from('customers')
      .select('id, name, line_user_id')
      .or(`id.eq.${customerKey},user_id.eq.${customerKey}`)
      .maybeSingle();
    customer = data;
  }

  const coachName = coach?.name || booking.coach_name || 'コーチ';
  const customerName = customer?.name || booking.customer_name || 'お客様';
  const dateStr = formatDateJa(booking.booking_date);
  const timeStr = booking.booking_time ? booking.booking_time.substring(0, 5) : '';

  if (customer?.line_user_id) {
    const customerMsg = buildRejectionNoticeText({
      customerName,
      coachName,
      dateStr,
      timeStr,
      reason: reasonText,
    });
    await pushMessage(customer.line_user_id, customerMsg);
    console.log('[finalize_reject] customer notified');
  } else {
    console.warn('[finalize_reject] customer has no line_user_id');
  }

  const coachMsg = buildRejectionCompleteText({ customerName });
  await pushMessage(lineUserId, coachMsg);
}

// ============================================
// ユーティリティ:クエリ文字列パース
// ============================================
function parseQueryString(str) {
  const params = {};
  if (!str) return params;
  const parts = str.split('&');
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
    }
  }
  return params;
}
