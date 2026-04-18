// netlify/functions/create-checkout-session.js
// お客様の「依頼を確定する」ボタン押下時に呼ばれる
// 流れ：
//   1. 入力値を検証
//   2. Supabase bookings に status='pending_payment' で仮予約を作成
//   3. Stripe Checkout セッションを作成（metadata に booking_id を埋め込む）
//   4. 決済URLを返す
//   5. ユーザーが決済完了 → stripe-webhook.js が bookings.status を 'confirmed' に更新

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  try {
    // ===== 1. 入力値パース =====
    const payload = JSON.parse(event.body || '{}');
    const {
      user_id,          // customer user_id (Supabase auth)
      coach_id,         // 依頼先コーチ（未設定可）
      store_key,        // 'kyoto' or 'fushimi'
      lesson_type,      // 'indoor' | 'round' | 'accompany' | 'comp'
      lesson_date,      // 'YYYY-MM-DD'
      lesson_time,      // 'HH:MM'
      duration_min,     // インドアのみ数値、他はnull
      amount_yen,       // 請求額（円、整数）
      lesson_label,     // 画面表示用ラベル（例: "インドア 50分"）
      golf_history,     // 'beginner' 等
      comment,          // 要望コメント
      customer_name,    // LINE通知/領収書用
      customer_email,   // 決済時のメール事前入力
    } = payload;

    // バリデーション
    if (!user_id) return json(400, corsHeaders, { error: 'user_id required' });
    if (!lesson_type) return json(400, corsHeaders, { error: 'lesson_type required' });
    if (!lesson_date) return json(400, corsHeaders, { error: 'lesson_date required' });
    if (!amount_yen || amount_yen < 100) return json(400, corsHeaders, { error: 'amount_yen invalid' });

    // ===== 2. Supabase に仮予約作成 =====
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const bookingPayload = {
      customer_user_id: user_id,
      coach_id: coach_id || null,
      store_key: store_key || null,
      lesson_type,
      lesson_date,
      lesson_time: lesson_time || null,
      duration_min: duration_min || null,
      amount_yen: Math.round(amount_yen),
      lesson_label: lesson_label || null,
      golf_history: golf_history || null,
      comment: comment || null,
      status: 'pending_payment',
      created_at: new Date().toISOString(),
    };

    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .insert(bookingPayload)
      .select()
      .single();

    if (bookingErr) {
      console.error('booking insert error:', bookingErr);
      // カラム不足の場合、最小セットで再試行
      const minimal = {
        customer_user_id: user_id,
        coach_id: coach_id || null,
        lesson_type,
        lesson_date,
        amount_yen: Math.round(amount_yen),
        status: 'pending_payment',
      };
      const retry = await supabase.from('bookings').insert(minimal).select().single();
      if (retry.error) {
        return json(500, corsHeaders, {
          error: 'booking_insert_failed',
          detail: retry.error.message,
        });
      }
      booking = retry.data;
    }

    // ===== 3. Stripe Checkout セッション作成 =====
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const siteUrl = process.env.SITE_URL || 'https://soft-speculoos-5ef188.netlify.app';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: customer_email || undefined,
      line_items: [
        {
          price_data: {
            currency: 'jpy',
            product_data: {
              name: lesson_label || `MyCoach ${lesson_type} レッスン`,
              description: `日時: ${lesson_date} ${lesson_time || ''}`.trim(),
            },
            unit_amount: Math.round(amount_yen),
          },
          quantity: 1,
        },
      ],
      metadata: {
        booking_id: String(booking.id),
        customer_user_id: String(user_id),
        coach_id: String(coach_id || ''),
        store_key: String(store_key || ''),
        lesson_type: String(lesson_type),
      },
      success_url: `${siteUrl}/customer.html?payment=success&booking=${booking.id}`,
      cancel_url: `${siteUrl}/customer.html?payment=cancel&booking=${booking.id}`,
    });

    // bookingsにsession_idを保存（Webhookで参照するため）
    try {
      await supabase
        .from('bookings')
        .update({ stripe_session_id: session.id })
        .eq('id', booking.id);
    } catch (_) {
      // stripe_session_idカラムが無い場合はスキップ
    }

    return json(200, corsHeaders, {
      ok: true,
      booking_id: booking.id,
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return json(500, corsHeaders, { error: err.message });
  }
};

function json(statusCode, headers, obj) {
  return {
    statusCode,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
