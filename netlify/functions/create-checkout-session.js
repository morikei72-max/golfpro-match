// netlify/functions/create-checkout-session.js
// MyCoach 決済セッション作成
// 【2026/4/25 v2】payment_intent_data.metadata 追加(自動返金対応)
//
// 処理の流れ:
// Pattern A: approved_booking_id あり
//   → 既存の bookings レコードを流用
//   → Stripe Checkout セッションだけ作成
//
// Pattern B: approved_booking_id なし(従来フロー・後方互換)
//   → bookings に pending_payment で新規INSERT
//   → Stripe Checkout セッション作成
//
// 【重要】payment_intent_data.metadata.booking_id を必ず付与
//   → これにより自動返金時に Stripe Search API で検索可能になる

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
    // パラメータ受取
    // ============================================
    const approvedBookingId = body.approved_booking_id || body.approvedBookingId || null;
    const customerId   = body.customer_id || body.customer_user_id || body.customerId;
    const coachId      = body.coach_id    || body.coachId;
    const storeKey     = body.store_key   || body.storeKey || 'kyoto';
    const lessonType   = body.lesson_type || body.lessonType || 'indoor';
    const minutes      = parseInt(body.minutes || body.duration_min || body.duration || 0, 10) || null;
    const totalPrice   = parseInt(body.total_price || body.amount_yen || body.amount || 0, 10);
    const bookingDate  = body.booking_date || body.lesson_date || body.date;
    let   bookingTime  = body.booking_time || body.lesson_time || body.start_time;
    const comment      = body.comment || body.golf_history || '';
    const agreedTerms  = !!body.agreed_terms;
    const customerName = body.customer_name || '';
    const coachName    = body.coach_name || body.lesson_label || '';

    // booking_time を 'HH:MM:SS' に正規化
    if (bookingTime && bookingTime.length === 5) bookingTime = bookingTime + ':00';

    // ============================================
    // 【Pattern A】approved_booking_id が指定されている場合
    //    既存レコードを流用して Stripe Checkout だけ作成
    // ============================================
    if (approvedBookingId) {
      console.log('[create-checkout-session] Pattern A: approved_booking_id =', approvedBookingId);

      // 既存の予約レコードを取得
      const { data: existingBooking, error: fetchErr } = await supabase
        .from('bookings')
        .select('*')
        .eq('id', approvedBookingId)
        .maybeSingle();

      if (fetchErr || !existingBooking) {
        console.error('[create-checkout-session] existing booking not found:', fetchErr);
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: '予約が見つかりませんでした', detail: fetchErr?.message }),
        };
      }

      // ステータスチェック:approved_pending_payment のみ許可
      if (existingBooking.status !== 'approved_pending_payment') {
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            error: 'この予約は現在決済できる状態ではありません',
            current_status: existingBooking.status,
          }),
        };
      }

      // Stripe Checkout セッション作成
      const origin =
        event.headers.origin ||
        event.headers.Origin ||
        'https://soft-speculoos-5ef188.netlify.app';

      const productName = existingBooking.coach_name
        ? `${existingBooking.coach_name} コーチ / ${lessonTypeLabel(existingBooking.lesson_type)}`
        : `MyCoach ${lessonTypeLabel(existingBooking.lesson_type)}`;

      const amount = parseInt(existingBooking.total_price, 10);

      // metadata 共通定義(Session と PaymentIntent 両方に付与)
      const metadata = {
        booking_id:  approvedBookingId,
        customer_id: existingBooking.customer_id || '',
        coach_id:    existingBooking.coach_id || '',
        store_key:   existingBooking.store_key || '',
        lesson_type: existingBooking.lesson_type || '',
      };

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'jpy',
              product_data: { name: productName },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/customer.html?payment=success&booking_id=${approvedBookingId}`,
        cancel_url:  `${origin}/customer.html?payment=cancel&booking_id=${approvedBookingId}`,
        metadata: metadata,
        // 【重要】PaymentIntent にも同じ metadata を付与
        // これがないと自動返金時に Stripe Search API で検索できない
        payment_intent_data: {
          metadata: metadata,
        },
      });

      console.log('[create-checkout-session] stripe session created for approved booking:', session.id);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          url: session.url,
          booking_id: approvedBookingId,
          mode: 'existing',
        }),
      };
    }

    // ============================================
    // 【Pattern B】従来フロー:新規INSERTして決済
    // ============================================
    console.log('[create-checkout-session] Pattern B: new booking');

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

    // 1) bookings へ pending_payment で仮INSERT
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

    // 2) Stripe Checkout セッション作成
    const origin =
      event.headers.origin ||
      event.headers.Origin ||
      'https://soft-speculoos-5ef188.netlify.app';

    const productName =
      coachName
        ? `${coachName} コーチ / ${lessonTypeLabel(lessonType)}`
        : `MyCoach ${lessonTypeLabel(lessonType)}`;

    // metadata 共通定義
    const metadataB = {
      booking_id:  bookingId,
      customer_id: customerId,
      coach_id:    coachId,
      store_key:   storeKey,
      lesson_type: lessonType,
    };

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
      metadata: metadataB,
      // 【重要】PaymentIntent にも同じ metadata を付与
      payment_intent_data: {
        metadata: metadataB,
      },
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url, booking_id: bookingId, mode: 'new' }),
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
    case 'custom':    return 'コーチ独自プラン';
    default:          return 'レッスン';
  }
}
