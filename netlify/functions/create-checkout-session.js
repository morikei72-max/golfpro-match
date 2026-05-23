// netlify/functions/create-checkout-session.js
// MyCoach 決済セッション作成
// 【2026/5/23 v6】エスクロー方式へ移行
//
// 振り分けロジック(エスクロー方式):
//   payment_intent_data.transfer_data は使用しない(コーチ即時帰属を止める)
//   → 決済額全額が株式会社ケイエスケーStripeアカウントに保留される
//   → コーチへの送金は release-coach-payout.js が
//      レッスン完了+7日後に Stripe transfers.create() で実行する
//
// 旧方式(v5以前)では transfer_data.destination でコーチ即時帰属していたが、
// レッスン未提供時のキャンセル・コーチ不正リスクが高かったため変更。
//
//
// 手数料率:
// ・本部手数料率: HQ_FEE_RATE = 0.164
// ・Stripe手数料率: STRIPE_FEE_RATE = 0.036
// ・店舗手数料率: stores.[lesson_type]_fee_rate (DB動的取得)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================
// 手数料率(コード内固定値)
// ============================================
const HQ_FEE_RATE = 0.164;
const STRIPE_FEE_RATE = 0.036;

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

    const approvedBookingId = body.approved_booking_id || body.approvedBookingId || null;
    const customerId   = body.customer_id || body.customer_user_id || body.customerId;
    const coachId      = body.coach_id    || body.coachId;
    const storeKey     = body.store_key   || body.storeKey || 'tozuike';
    const lessonType   = body.lesson_type || body.lessonType || 'indoor';
    const minutes      = parseInt(body.minutes || body.duration_min || body.duration || 0, 10) || null;
    const totalPrice   = parseInt(body.total_price || body.amount_yen || body.amount || 0, 10);
    const bookingDate  = body.booking_date || body.lesson_date || body.date;
    let   bookingTime  = body.booking_time || body.lesson_time || body.start_time;
    const comment      = body.comment || body.golf_history || '';
    const agreedTerms  = !!body.agreed_terms;
    const customerName = body.customer_name || '';
    const coachName    = body.coach_name || body.lesson_label || '';

    if (bookingTime && bookingTime.length === 5) bookingTime = bookingTime + ':00';

    // ============================================
    // 【Pattern A】approved_booking_id 指定
    // ============================================
    if (approvedBookingId) {
      console.log('[create-checkout-session] Pattern A:', approvedBookingId);

      const { data: existingBooking, error: fetchErr } = await supabase
        .from('bookings')
        .select('*')
        .eq('id', approvedBookingId)
        .maybeSingle();

      if (fetchErr || !existingBooking) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: '予約が見つかりませんでした', detail: fetchErr?.message }),
        };
      }

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

      const splitResult = await calculateFeeSplit({
        coachId: existingBooking.coach_id,
        storeKey: existingBooking.store_key,
        lessonType: existingBooking.lesson_type,
        amount: parseInt(existingBooking.total_price, 10),
      });

      if (splitResult.error) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: splitResult.error }),
        };
      }

      const origin =
        event.headers.origin ||
        event.headers.Origin ||
        'https://soft-speculoos-5ef188.netlify.app';

      const productName = existingBooking.coach_name
        ? `${existingBooking.coach_name} コーチ / ${lessonTypeLabel(existingBooking.lesson_type)}`
        : `MyCoach ${lessonTypeLabel(existingBooking.lesson_type)}`;

      const amount = parseInt(existingBooking.total_price, 10);

      const metadata = {
        booking_id:  approvedBookingId,
        customer_id: existingBooking.customer_id || '',
        coach_id:    existingBooking.coach_id || '',
        store_key:   existingBooking.store_key || '',
        lesson_type: existingBooking.lesson_type || '',
        hq_fee:      String(splitResult.hqFee),
        store_fee:   String(splitResult.storeFee),
        stripe_fee:  String(splitResult.stripeFee),
        application_fee: String(splitResult.applicationFee),
        coach_amount:    String(splitResult.coachAmount),
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
        // ★ エスクロー方式: transfer_data を指定しない
        // 決済額は全額が株式会社ケイエスケーStripeアカウントに保留される
        // コーチへの送金は release-coach-payout.js が完了+7日後に実行する
        payment_intent_data: {
          metadata: metadata,
        },
      });

      console.log('[create-checkout-session] Pattern A created:', {
        sessionId: session.id,
        amount,
        hqFee: splitResult.hqFee,
        storeFee: splitResult.storeFee,
        stripeFee: splitResult.stripeFee,
        applicationFee: splitResult.applicationFee,
        coachAmount: splitResult.coachAmount,
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          url: session.url,
          booking_id: approvedBookingId,
          mode: 'existing',
          fee_breakdown: {
            total: amount,
            hq_fee: splitResult.hqFee,
            store_fee: splitResult.storeFee,
            stripe_fee: splitResult.stripeFee,
            application_fee: splitResult.applicationFee,
            coach_amount: splitResult.coachAmount,
          },
        }),
      };
    }

    // ============================================
    // 【Pattern B】新規INSERT
    // ============================================
    console.log('[create-checkout-session] Pattern B: new booking');

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

    const splitResultB = await calculateFeeSplit({
      coachId: coachId,
      storeKey: storeKey,
      lessonType: lessonType,
      amount: totalPrice,
    });

    if (splitResultB.error) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: splitResultB.error }),
      };
    }

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

    const origin =
      event.headers.origin ||
      event.headers.Origin ||
      'https://soft-speculoos-5ef188.netlify.app';

    const productName =
      coachName
        ? `${coachName} コーチ / ${lessonTypeLabel(lessonType)}`
        : `MyCoach ${lessonTypeLabel(lessonType)}`;

    const metadataB = {
      booking_id:  bookingId,
      customer_id: customerId,
      coach_id:    coachId,
      store_key:   storeKey,
      lesson_type: lessonType,
      hq_fee:      String(splitResultB.hqFee),
      store_fee:   String(splitResultB.storeFee),
      stripe_fee:  String(splitResultB.stripeFee),
      application_fee: String(splitResultB.applicationFee),
      coach_amount:    String(splitResultB.coachAmount),
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
      // ★ エスクロー方式: transfer_data を指定しない
      // 決済額は全額が株式会社ケイエスケーStripeアカウントに保留される
      // コーチへの送金は release-coach-payout.js が完了+7日後に実行する
      payment_intent_data: {
        metadata: metadataB,
      },
    });

    console.log('[create-checkout-session] Pattern B created:', {
      sessionId: session.id,
      amount: totalPrice,
      hqFee: splitResultB.hqFee,
      storeFee: splitResultB.storeFee,
      stripeFee: splitResultB.stripeFee,
      applicationFee: splitResultB.applicationFee,
      coachAmount: splitResultB.coachAmount,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        url: session.url,
        booking_id: bookingId,
        mode: 'new',
        fee_breakdown: {
          total: totalPrice,
          hq_fee: splitResultB.hqFee,
          store_fee: splitResultB.storeFee,
          stripe_fee: splitResultB.stripeFee,
          application_fee: splitResultB.applicationFee,
          coach_amount: splitResultB.coachAmount,
        },
      }),
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

// ============================================
// 振り分け計算関数
// ============================================
async function calculateFeeSplit({ coachId, storeKey, lessonType, amount }) {
  const { data: coach, error: coachErr } = await supabase
    .from('coaches')
    .select('stripe_account_id, stripe_charges_enabled')
    .eq('id', coachId)
    .maybeSingle();

  if (coachErr) {
    return { error: 'コーチ情報の取得に失敗しました' };
  }
  if (!coach) {
    return { error: 'コーチが見つかりませんでした' };
  }
  if (!coach.stripe_account_id) {
    return { error: 'このコーチはStripe登録が完了していません(stripe_account_id未設定)' };
  }
  if (!coach.stripe_charges_enabled) {
    return { error: 'このコーチはStripe決済受付が有効になっていません' };
  }

  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .select('indoor_fee_rate, round_fee_rate, accompany_fee_rate, comp_fee_rate, custom_fee_rate')
    .eq('store_key', storeKey)
    .maybeSingle();

  if (storeErr) {
    return { error: '店舗情報の取得に失敗しました' };
  }
  if (!store) {
    return { error: '店舗が見つかりませんでした(store_key=' + storeKey + ')' };
  }

  let storeFeeRate = 0;
  switch (lessonType) {
    case 'indoor':    storeFeeRate = parseFloat(store.indoor_fee_rate)    || 0; break;
    case 'round':     storeFeeRate = parseFloat(store.round_fee_rate)     || 0; break;
    case 'accompany': storeFeeRate = parseFloat(store.accompany_fee_rate) || 0; break;
    case 'comp':      storeFeeRate = parseFloat(store.comp_fee_rate)      || 0; break;
    case 'custom':    storeFeeRate = parseFloat(store.custom_fee_rate)    || 0; break;
    default:          storeFeeRate = 0;
  }

  // 振り分け計算(円単位・整数化)
  // application_fee_amount は使わず、transfer_data.amount のみで制御
  const hqFee     = Math.floor(amount * HQ_FEE_RATE);
  const storeFee  = Math.floor(amount * storeFeeRate);
  const stripeFee = Math.floor(amount * STRIPE_FEE_RATE);
  const applicationFee = hqFee + storeFee;
  const coachAmount = amount - applicationFee - stripeFee;

  if (applicationFee < 0 || applicationFee >= amount) {
    return { error: '手数料計算エラー(application_fee=' + applicationFee + ', amount=' + amount + ')' };
  }
  if (coachAmount <= 0) {
    return { error: 'コーチ受取額が0以下です(rates設定を確認してください)' };
  }

  return {
    coachStripeAccountId: coach.stripe_account_id,
    hqFee,
    storeFee,
    stripeFee,
    applicationFee,
    coachAmount,
    hqFeeRate: HQ_FEE_RATE,
    storeFeeRate,
    stripeFeeRate: STRIPE_FEE_RATE,
  };
}

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
