// netlify/functions/create-checkout-session.js
// MyCoach 決済セッション作成
// 【2026/5/9 v3】Stripe Connect 自動振り分け実装
//
// 振り分けロジック:
//   application_fee_amount = 本部手数料 + 店舗手数料
//   transfer_data.destination = コーチのStripe Connectアカウント
//   → 残額が自動的にコーチへ送金される
//
// 手数料率の取得:
//   ・本部手数料率: コード内固定値 HQ_FEE_RATE = 0.15
//   ・店舗手数料率: stores.[lesson_type]_fee_rate (DB最新値・動的取得)
//
// レッスンタイプ別の店舗手数料カラム:
//   indoor    → stores.indoor_fee_rate
//   round     → stores.round_fee_rate
//   accompany → stores.accompany_fee_rate
//   comp      → stores.comp_fee_rate
//   custom    → stores.custom_fee_rate

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
// 本部手数料率(コード内固定値・将来DB化可能)
// ============================================
const HQ_FEE_RATE = 0.15;

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

      // ステータスチェック
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

      // ============================================
      // 振り分け処理(Pattern A)
      // ============================================
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

      // metadata 共通定義
      const metadata = {
        booking_id:  approvedBookingId,
        customer_id: existingBooking.customer_id || '',
        coach_id:    existingBooking.coach_id || '',
        store_key:   existingBooking.store_key || '',
        lesson_type: existingBooking.lesson_type || '',
        hq_fee:      String(splitResult.hqFee),
        store_fee:   String(splitResult.storeFee),
        application_fee: String(splitResult.applicationFee),
        coach_amount:    String(splitResult.coachAmount),
      };

      // Stripe Checkout セッション作成(振り分け付き)
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
        payment_intent_data: {
          application_fee_amount: splitResult.applicationFee,
          transfer_data: {
            destination: splitResult.coachStripeAccountId,
          },
          metadata: metadata,
        },
      });

      console.log('[create-checkout-session] stripe session created (Pattern A):', {
        sessionId: session.id,
        amount,
        hqFee: splitResult.hqFee,
        storeFee: splitResult.storeFee,
        applicationFee: splitResult.applicationFee,
        coachAmount: splitResult.coachAmount,
        coachStripeAccountId: splitResult.coachStripeAccountId,
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
            application_fee: splitResult.applicationFee,
            coach_amount: splitResult.coachAmount,
          },
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

    // ============================================
    // 振り分け処理(Pattern B)
    // ============================================
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

    // 2) Stripe Checkout セッション作成(振り分け付き)
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
      payment_intent_data: {
        application_fee_amount: splitResultB.applicationFee,
        transfer_data: {
          destination: splitResultB.coachStripeAccountId,
        },
        metadata: metadataB,
      },
    });

    console.log('[create-checkout-session] stripe session created (Pattern B):', {
      sessionId: session.id,
      amount: totalPrice,
      hqFee: splitResultB.hqFee,
      storeFee: splitResultB.storeFee,
      applicationFee: splitResultB.applicationFee,
      coachAmount: splitResultB.coachAmount,
      coachStripeAccountId: splitResultB.coachStripeAccountId,
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
  // 1. コーチの Stripe アカウント情報取得
  const { data: coach, error: coachErr } = await supabase
    .from('coaches')
    .select('stripe_account_id, stripe_charges_enabled')
    .eq('user_id', coachId)
    .maybeSingle();

  if (coachErr) {
    console.error('[calculateFeeSplit] coach fetch error:', coachErr);
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

  // 2. 店舗の手数料率取得
  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .select('indoor_fee_rate, round_fee_rate, accompany_fee_rate, comp_fee_rate, custom_fee_rate')
    .eq('store_key', storeKey)
    .maybeSingle();

  if (storeErr) {
    console.error('[calculateFeeSplit] store fetch error:', storeErr);
    return { error: '店舗情報の取得に失敗しました' };
  }
  if (!store) {
    return { error: '店舗が見つかりませんでした(store_key=' + storeKey + ')' };
  }

  // 3. レッスンタイプに応じた店舗手数料率取得
  let storeFeeRate = 0;
  switch (lessonType) {
    case 'indoor':    storeFeeRate = parseFloat(store.indoor_fee_rate)    || 0; break;
    case 'round':     storeFeeRate = parseFloat(store.round_fee_rate)     || 0; break;
    case 'accompany': storeFeeRate = parseFloat(store.accompany_fee_rate) || 0; break;
    case 'comp':      storeFeeRate = parseFloat(store.comp_fee_rate)      || 0; break;
    case 'custom':    storeFeeRate = parseFloat(store.custom_fee_rate)    || 0; break;
    default:          storeFeeRate = 0;
  }

  // 4. 振り分け計算(円単位・整数化)
  const hqFee    = Math.floor(amount * HQ_FEE_RATE);
  const storeFee = Math.floor(amount * storeFeeRate);
  const applicationFee = hqFee + storeFee;
  const coachAmount = amount - applicationFee;

  // 5. バリデーション
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
    applicationFee,
    coachAmount,
    hqFeeRate: HQ_FEE_RATE,
    storeFeeRate,
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
