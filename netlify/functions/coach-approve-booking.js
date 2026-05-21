// netlify/functions/coach-approve-booking.js
// コーチ画面(Web)からの予約承認処理
// 【2026/4/25 新規作成】
// 【2026/5/18 更新】Task G STEP 4 - 店舗向け承認通知を追加
// 【2026/5/21 更新】
//   - members テーブルから plan_name を取得
//   - buildStoreApprovedFlex に planName を渡す
//   - customers select に email カラムを追加
//
// 処理の流れ:
// 1. booking_id を受け取る
// 2. bookings.status を 'approved_pending_payment' に更新
// 3. お客様のLINEに決済リンクを送信
// 4. 店舗のLINEに緑承認カードを送信(plan_name付き)
// 5. コーチ画面に成功レスポンスを返す
//
// ※ line-webhook.js の handleApprove と同等のロジック

const { createClient } = require('@supabase/supabase-js');
const {
  pushMessage,
  pushFlexMessage,
  buildApprovalCompleteText,
  buildStoreApprovedFlex,
  formatDateJa,
  calcAge,
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
    //    【2026/5/18 拡張】customers から furigana, age, birth_date, is_approved も取得
    //    【2026/5/21 拡張】email も取得して、後段の members 引き当てに使用
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
        .select('id, name, email, furigana, age, birth_date, is_approved, line_user_id')
        .or(`id.eq.${customerKey},user_id.eq.${customerKey}`)
        .maybeSingle();
      customer = data;
    }

    // ============================================
    // 4. 店舗情報を取得【Task G STEP 4 新規】
    // ============================================
    let store = null;
    if (booking.store_key) {
      const { data, error: storeErr } = await supabase
        .from('stores')
        .select('id, name, line_user_id')
        .eq('store_key', booking.store_key)
        .maybeSingle();
      if (storeErr) {
        console.error('[coach-approve-booking] store fetch error:', storeErr);
      } else {
        store = data;
      }
    }

    // ============================================
    // 5. 【2026/5/21 新規】members テーブルから plan_name を取得
    //    店舗向け緑カードの「プラン」欄に表示する
    // ============================================
    let planName = null;
    try {
      const customerEmail = customer?.email ? String(customer.email).toLowerCase().trim() : null;
      const storeKey = booking.store_key;
      if (customerEmail && storeKey) {
        const { data: memberRow, error: memberErr } = await supabase
          .from('members')
          .select('plan_name')
          .eq('store_key', storeKey)
          .eq('email', customerEmail)
          .eq('is_active', true)
          .maybeSingle();
        if (memberErr) {
          console.error('[coach-approve-booking] members fetch error:', memberErr);
        } else if (memberRow && memberRow.plan_name) {
          planName = memberRow.plan_name;
        }
        console.log('[coach-approve-booking] plan_name lookup:', { customerEmail, storeKey, planName });
      } else {
        console.log('[coach-approve-booking] plan_name lookup skipped (no email or store_key)');
      }
    } catch (e) {
      console.error('[coach-approve-booking] plan_name lookup exception:', e);
    }

    // ============================================
    // 6. 共通パラメータ準備
    // ============================================
    const coachName = coach?.name || booking.coach_name || 'コーチ';
    const customerName = customer?.name || booking.customer_name || 'お客様';
    const customerFurigana = customer?.furigana || null;
    const isApproved = !!customer?.is_approved;
    const dateStr = formatDateJa(booking.booking_date);
    const timeStr = booking.booking_time ? booking.booking_time.substring(0, 5) : '';
    const amount = booking.total_price || 0;
    const paymentUrl = `${BASE_URL}/customer.html?action=pay&booking_id=${bookingId}`;

    const lessonType = LESSON_TYPE_LABEL[booking.lesson_type] || booking.lesson_type || '—';
    const minutes = booking.minutes || null;
    const storeName = store?.name || booking.store_key || '—';

    // 年齢計算:birth_date 優先、なければ age カラム
    let customerAge = null;
    if (customer?.birth_date) {
      customerAge = calcAge(customer.birth_date);
    } else if (customer?.age) {
      customerAge = customer.age;
    }

    // ============================================
    // 7. お客様のLINEに決済案内を送信(既存)
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
    // 8. 店舗のLINEに緑承認カードを送信
    //    【2026/5/21 更新】planName を渡す
    // ============================================
    let storeNotified = false;
    if (store?.line_user_id) {
      const storeFlex = buildStoreApprovedFlex({
        customerName,
        customerFurigana,
        customerAge,
        isApproved,
        planName,
        coachName,
        lessonType,
        dateStr,
        timeStr,
        storeName,
        amount,
      });

      const storeAltText = `✅ コーチが承認しました - ${customerName}様 / ${dateStr}`;

      const storePushResult = await pushFlexMessage(
        store.line_user_id,
        storeAltText,
        storeFlex
      );
      storeNotified = storePushResult.ok;
      console.log('[coach-approve-booking] store flex push:', storePushResult);
    } else {
      console.warn('[coach-approve-booking] store has no line_user_id');
    }

    // ============================================
    // 9. 成功レスポンス
    // ============================================
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        booking_id: bookingId,
        status: 'approved_pending_payment',
        customer_notified: customerNotified,
        store_notified: storeNotified,
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
