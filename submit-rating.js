// netlify/functions/submit-rating.js
// MyCoach お客様評価送信API
// 【2026/5/23 Phase 2 新規】customer-rating.html からの評価送信を受け取る
//
// 動作:
//   1. booking_id を受け取り、coach_ratings テーブルに INSERT
//   2. bookings.rated_at を現在時刻で更新
//   3. 二重評価防止(UNIQUE制約により自動的に弾かれる)
//
// 呼び出し方法:
//   POST /.netlify/functions/submit-rating
//   body: {
//     booking_id, coach_id, customer_id,
//     rating_satisfaction, rating_value, rating_improvement,
//     rating_clarity, rating_kindness, rating_rebooking,
//     comment(任意)
//   }
//
// 環境変数:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
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
    const bookingId = body.booking_id;
    const coachId = body.coach_id;
    const customerId = body.customer_id || null;

    if (!bookingId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'booking_id is required' }),
      };
    }

    // 6項目すべての必須バリデーション(1-5整数)
    const ratingKeys = [
      'rating_satisfaction',
      'rating_value',
      'rating_improvement',
      'rating_clarity',
      'rating_kindness',
      'rating_rebooking',
    ];
    const ratings = {};
    for (const k of ratingKeys) {
      const v = parseInt(body[k], 10);
      if (!Number.isInteger(v) || v < 1 || v > 5) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ ok: false, error: `${k} は 1〜5 の整数で必須です` }),
        };
      }
      ratings[k] = v;
    }

    const comment = (body.comment && typeof body.comment === 'string')
      ? body.comment.trim().substring(0, 2000)
      : null;

    // 予約確認(coach_id を取り直す)
    const { data: booking, error: bErr } = await supabase
      .from('bookings')
      .select('id, coach_id, customer_id, status')
      .eq('id', bookingId)
      .maybeSingle();

    if (bErr || !booking) {
      console.error('[submit-rating] booking fetch error:', bErr);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ ok: false, error: '予約が見つかりません' }),
      };
    }

    if (booking.status !== 'confirmed') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: '確定済みのレッスンのみ評価可能です' }),
      };
    }

    // 既に評価済みかチェック
    const { data: existing } = await supabase
      .from('coach_ratings')
      .select('id')
      .eq('booking_id', bookingId)
      .maybeSingle();

    if (existing) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ ok: false, error: 'この予約は既に評価されています' }),
      };
    }

    // INSERT
    const { data: inserted, error: insErr } = await supabase
      .from('coach_ratings')
      .insert({
        booking_id: bookingId,
        coach_id: booking.coach_id,
        customer_id: customerId || booking.customer_id || null,
        rating_satisfaction: ratings.rating_satisfaction,
        rating_value: ratings.rating_value,
        rating_improvement: ratings.rating_improvement,
        rating_clarity: ratings.rating_clarity,
        rating_kindness: ratings.rating_kindness,
        rating_rebooking: ratings.rating_rebooking,
        comment: comment,
      })
      .select()
      .single();

    if (insErr) {
      console.error('[submit-rating] insert error:', insErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: '評価の保存に失敗しました: ' + insErr.message }),
      };
    }

    // bookings.rated_at 更新(成功してもしなくても処理続行)
    try {
      await supabase
        .from('bookings')
        .update({ rated_at: new Date().toISOString() })
        .eq('id', bookingId);
    } catch (e) {
      console.error('[submit-rating] bookings.rated_at update error (non-fatal):', e);
    }

    console.log('[submit-rating] success. rating_id:', inserted?.id);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        rating_id: inserted?.id,
        message: '評価ありがとうございました',
      }),
    };
  } catch (err) {
    console.error('[submit-rating] handler error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
