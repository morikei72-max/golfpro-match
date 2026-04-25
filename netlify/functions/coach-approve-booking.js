// netlify/functions/coach-approve-booking.js
// コーチ画面(Web)からの予約承認処理
// 【2026/4/25 新規作成】
//
// 処理の流れ:
// 1. booking_id を受け取る
// 2. bookings.status を 'approved_pending_payment' に更新
// 3. お客様のLINEに決済リンクを送信
// 4. コーチ画面に成功レスポンスを返す
//
// ※ line-webhook.js の handleApprove と同等のロジック

const { createClient } = require('@supabase/supabase-js');
const {
  pushMessage,
  buildApprovalCompleteText,
  formatDateJa,
} = require('./line-notify');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LESSON_TYPE_LABEL = {
  indoor: 'インドアゴルフレッスン',
  round: 'ラウンドレッスン',
  accompany: '同伴ラウンド',
  comp: 'コンペ参加',
  custom: 'コーチ独自プラン',
};

const BASE_URL = 'https://soft-speculoos-5ef188.netlify.app';

exports.handler = async (event) => {
  // CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const bookingId = body.booking_id || body.bookingId;

    if (!bookingId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'booking_id が必要です' }),
      };
    }

    console.log('[coach-approve-booking] booking_id:', bookingId);

    // ============================================
    // 1. bookings.status を 'approved_pending_payment' に更新
    //    ※ pending_approval の予約のみ更新対象(二重承認防止)
    // ============================================
    const { error: updateErr } = await supabase
      .from('bookings')
      .update({ status: 'approved_pending_payment' })
      .eq('id', bookingId)
      .eq('status', 'pending_approval');

    if (updateErr) {
      console.error('[coach-approve-booking] update error:', updateErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          ok: false,
          error: '予約ステータスの更新に失敗しました',
          detail: updateErr.message,
        }),
      };
    }

    // ============================================
    // 2. 更新後の予約データを取得
    // ============================================
    const { data: booking, error: fetchErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .maybeSingle();

    if (fetchErr || !booking) {
      console.error('[coach-approve-booking] booking fetch error:', fetchErr);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          ok: false,
          error: '予約が見つかりません',
        }),
      };
    }

    // ステータスチェック:更新されていない場合(既に処理済み)
    if (booking.status !== 'approved_pending_payment') {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          ok: false,
          error: 'この予約は既に処理されています',
          current_status: booking.status,
        }),
      };
    }

    console.log('[coach-approve-booking] booking updated to approved_pending_payment');

    // ============================================
    // 3. コーチ情報・お客様情報を取得
    // ============================================
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

    const lessonType = LESSON_TYPE_LABEL[booking.lesson_type] || booking.lesson_type || '—';
    const minutes = booking.minutes || null;

    // ============================================
    // 4. お客様のLINEに決済案内を送信
    // ============================================
    let customerNotified = false;
    if (customer?.line_user_id) {
      const customerMsg = buildApprovalCompleteText({
        customerName,
        coachName,
        lessonType,
        minutes,
        dateStr,
        timeStr,
        amount,
        paymentUrl,
      });
      const pushResult = await pushMessage(customer.line_user_id, customerMsg);
      customerNotified = pushResult.ok;
      console.log('[coach-approve-booking] customer LINE push:', pushResult);
    } else {
      console.warn('[coach-approve-booking] customer has no line_user_id');
    }

    // ============================================
    // 5. 成功レスポンス
    // ============================================
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        booking_id: bookingId,
        status: 'approved_pending_payment',
        customer_notified: customerNotified,
        message: '予約を承認しました。お客様のLINEに決済リンクを送信しました。',
      }),
    };
  } catch (err) {
    console.error('[coach-approve-booking] error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: 'サーバーエラーが発生しました',
        detail: err.message,
      }),
    };
  }
};
