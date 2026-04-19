// netlify/functions/create-checkout-session.js
// MyCoach 決済セッション作成（MASTER_DB.md 準拠・2026/4/19）
// bookings 実カラムのみ使用: customer_id, coach_id, store_key, lesson_type,
//   minutes, total_price, booking_date, booking_time, comment, status,
//   agreed_terms, customer_name, coach_name

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  // CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // ============================================
    // customer.html から届く想定パラメータを吸収
    // 新旧どちらの名前で来ても受けられるようにする
    // ============================================
    const customerId   = body.customer_id || body.customer_user_id || body.customerId;
    const coachId      = body.coach_id    || body.coachId;
    const storeKey     = body.store_key   || body.storeKey || 'kyoto';
    const lessonType   = body.lesson_type || body.lessonType || 'indoor';
    const minutes      = parseInt(body.minutes || body.duration_min || body.duration || 0, 10) || null;
    const totalPrice   = parseInt(body.total_price || body.amount_yen || body.amount || 0, 10);
    const bookingDate  = body.booking_date || body.lesson_date || body.date; // 'YYYY-MM-DD'
    let   bookingTime  = body.booking_time || body.lesson_time || body.start_time; // 'HH:MM' or 'HH:MM:SS'
    const comment      = body.comment || body.golf_history || '';
    const agreedTerms  = !!body.agreed_terms;
    const customerName = body.customer_name || '';
    const coachName    = body.coach_name || body.lesson_label || '';

    // booking_time を 'HH:MM:SS' に正規化
    if (bookingTime && bookingTime.length === 5) bookingTime = bookingTime + ':00';

    // 必須項目チェック
    if (!customerId || !coachId || !totalPrice || !bookingDate || !bookingTime) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: '必須項目が不足しています',
          received: { customerId, coachId, totalPrice, bookingDate, bookingTime },
        }),
      };
    }

    // ============================================
    // 1) bookings へ pending_payment で仮INSERT
    // ============================================
    const { data: booking, error: insertErr } = await supabase
      .from('bookings')
      .insert({
        customer_id:   customerId,
        coach_id:      coachId,
        store_key:     storeKey,
        lesson_type:   lessonType,
        minutes:       minutes,
        total_price:   totalPrice,
        booking_date:  bookingDate,
        booking_time:  bookingTime,
        comment:       comment,
        status:        'pending_payment',
        agreed_terms:  agreedTerms,
        customer_name: customerName,
        coach_name:    coachName,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('bookings insert error:', insertErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'bookings insert failed', detail: insertErr.message }),
      };
    }

    const bookingId = booking.id;

    // ============================================
    // 2) Stripe Checkout セッション作成
    // ============================================
    const origin =
      event.headers.origin ||
      event.headers.Origin ||
      'https://soft-speculoos-5ef188.netlify.app';

    const productName =
      coachName
        ? `${coachName} コーチ / ${lessonTypeLabel(lessonType)}`
        : `MyCoach ${lessonTypeLabel(lessonType)}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'jpy',
            product_data: { name: productName },
            unit_amount: totalPrice,
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/customer.html?payment=success&booking_id=${bookingId}`,
      cancel_url:  `${origin}/customer.html?payment=cancel&booking_id=${bookingId}`,
      metadata: {
        booking_id:  bookingId,
        customer_id: customerId,
        coach_id:    coachId,
        store_key:   storeKey,
        lesson_type: lessonType,
      },
    });

    // bookings に Stripe セッションIDを保存（任意カラム。存在しなければスキップ）
    // ※MASTER_DB.md 未登録のため、ここでは保存しない。必要なら後日 ALTER TABLE で追加。

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url, booking_id: bookingId }),
    };
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

function lessonTypeLabel(t) {
  switch (t) {
    case 'indoor':    return 'インドアレッスン';
    case 'round':     return 'ラウンドレッスン';
    case 'accompany': return '同伴ラウンド';
    case 'comp':      return 'コンペ参加';
    default:          return 'レッスン';
  }
}
