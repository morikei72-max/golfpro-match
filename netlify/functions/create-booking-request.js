// netlify/functions/create-booking-request.js
// MyCoach 予約申込（コーチ承認待ちフロー）
// お客様が予約申込ボタンを押した時に呼ばれる
//
// 処理の流れ：
// 1. バリデーション
// 2. bookings INSERT (status='pending_approval')
// 3. コーチの line_user_id を取得
// 4. コーチのLINEへ Flex Message（承認／却下ボタン付き）を送信
// 5. お客様画面に bookingId を返却

const { createClient } = require('@supabase/supabase-js');
const {
  pushFlexMessage,
  buildApprovalRequestFlex,
  buildApprovalRequestText,
  formatDateJa,
} = require('./line-notify');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================
// store_key から正式店舗名へのマッピング
// ============================================
const STORE_KEY_TO_NAME = {
  kyoto: 'Golf Create 戸津池店',
};

// ============================================
// レッスン種別の表示名マッピング
// ============================================
const LESSON_TYPE_LABEL = {
  indoor: 'インドアゴルフレッスン',
  round: 'ラウンドレッスン',
  accompany: '同伴ラウンド',
  comp: 'コンペ参加',
};

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
    // 1. パラメータ受取（create-checkout-session.jsと同じ構造）
    // ============================================
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
    // 2. バリデーション
    // ============================================
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
    // 3. bookings へ pending_approval で INSERT
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
        status:        'pending_approval',  // ★ 新ステータス
        agreed_terms:  agreedTerms,
        customer_name: customerName,
        coach_name:    coachName,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[create-booking-request] bookings insert error:', insertErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'bookings insert failed', detail: insertErr.message }),
      };
    }

    const bookingId = booking.id;
    console.log('[create-booking-request] booking created:', bookingId);

    // ============================================
    // 4. コーチ情報を取得（line_user_id 取得のため）
    // ============================================
    const { data: coach, error: coachErr } = await supabase
      .from('coaches')
      .select('id, name, line_user_id')
      .eq('id', coachId)
      .maybeSingle();

    if (coachErr) {
      console.error('[create-booking-request] coach fetch error:', coachErr);
      // 予約自体は作成済みなので、LINE通知失敗でもエラー返さず続行
    }

    // ============================================
    // 5. コーチのLINEへFlex Message送信
    // ============================================
    if (coach?.line_user_id) {
      // 店舗名を正式名称に変換
      const storeName = STORE_KEY_TO_NAME[storeKey] || storeKey;

      // 日付を日本語フォーマットに
      const dateStr = formatDateJa(bookingDate);
      const timeStr = bookingTime ? bookingTime.substring(0, 5) : '';

      // レッスン種別の表示名
      const lessonLabel = LESSON_TYPE_LABEL[lessonType] || lessonType;

      // お客様名
      const displayCustomerName = customerName || 'お客様';
      const displayCoachName = coach.name || coachName || 'コーチ';

      // Flex Message構築
      const flexContent = buildApprovalRequestFlex({
        bookingId,
        customerName: displayCustomerName,
        lessonType: lessonLabel,
        dateStr,
        timeStr,
        storeName,
        amount: totalPrice,
      });

      // altText（通知一覧表示用）
      const altText = buildApprovalRequestText({
        coachName: displayCoachName,
        customerName: displayCustomerName,
        lessonType: lessonLabel,
        dateStr,
        timeStr,
        storeName,
        amount: totalPrice,
      });

      // 送信
      const pushResult = await pushFlexMessage(
        coach.line_user_id,
        altText,
        flexContent
      );

      console.log('[create-booking-request] flex push result:', pushResult);

      if (!pushResult.ok) {
        console.warn('[create-booking-request] LINE通知失敗ですが予約は作成済み');
      }
    } else {
      console.warn('[create-booking-request] coach has no line_user_id:', coachId);
    }

    // ============================================
    // 6. お客様画面に結果返却
    // ============================================
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        booking_id: bookingId,
        status: 'pending_approval',
        message: 'コーチに承認依頼を送信しました。承認されましたらLINEでお知らせします。',
        coach_notified: !!coach?.line_user_id,
      }),
    };
  } catch (err) {
    console.error('[create-booking-request] error:', err);
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
