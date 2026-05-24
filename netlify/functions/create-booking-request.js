// netlify/functions/create-booking-request.js
// MyCoach 予約申込(コーチ承認待ちフロー)
// お客様が予約申込ボタンを押した時に呼ばれる
//
// 処理の流れ:
// 1. バリデーション
// 2. customerId を customers.id に解決(auth user ID が来ても対応)
// 3. bookings INSERT (status='pending_approval')
// 4. コーチの line_user_id を取得
// 5. コーチのLINEへ Flex Message(承認/却下ボタン付き)を送信
// 6. 店舗のLINEへ Flex Message(オレンジカード)を送信
// 7. お客様画面に bookingId を返却
//
// 【2026/5/21 更新】
//   - customer_id 解決ロジックを INSERT 前に移動
//   - auth user ID が来ても customers.id に変換して INSERT
//   - bookings_customer_id_fkey 制約違反(23503)を防止
//   - 店舗向けオレンジカードに plan_name(hacomonoメンバー情報)を表示する処理を追加

const { createClient } = require('@supabase/supabase-js');
const {
  pushFlexMessage,
  buildApprovalRequestFlex,
  buildApprovalRequestText,
  buildStorePendingRequestFlex,
  formatDateJa,
  calcAge,
} = require('./line-notify');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================
// store_key から正式店舗名へのマッピング
// ============================================
const STORE_KEY_TO_NAME = {
  tozuike: 'Golf Create 戸津池店',
};

// ============================================
// レッスン種別の表示名マッピング
// ============================================
const LESSON_TYPE_LABEL = {
  indoor: 'インドアゴルフレッスン',
  round: 'ラウンドレッスン',
  accompany: '同伴ラウンド',
  comp: 'コンペ参加',
  custom: 'コーチ独自プラン',
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
    // 1. パラメータ受取
    // ============================================
    const rawCustomerId = body.customer_id || body.customer_user_id || body.customerId;
    const coachId      = body.coach_id    || body.coachId;
    const storeKey     = body.store_key   || body.storeKey || 'tozuike';
    const lessonType   = body.lesson_type || body.lessonType || 'indoor';
    const minutes      = parseInt(body.minutes || body.duration_min || body.duration || 0, 10) || null;
    const totalPrice   = parseInt(body.total_price || body.amount_yen || body.amount || 0, 10);
    const bookingDate  = body.booking_date || body.lesson_date || body.date;
    let   bookingTime  = body.booking_time || body.lesson_time || body.start_time;
    const comment      = body.comment || body.golf_history || '';
    const agreedTerms  = !!body.agreed_terms;
    const customerNameInput = body.customer_name || '';
    const coachName    = body.coach_name || body.lesson_label || '';
    // 【2026/5/24 CP4 追加】クーポン情報
    const couponId         = body.coupon_id || null;
    const couponCode       = body.coupon_code || null;
    const originalPrice    = parseInt(body.original_price || totalPrice, 10) || totalPrice;
    const discountAmount   = parseInt(body.discount_amount || 0, 10) || 0;

    // booking_time を 'HH:MM:SS' に正規化
    if (bookingTime && bookingTime.length === 5) bookingTime = bookingTime + ':00';

    // ============================================
    // 2. バリデーション
    // ============================================
    if (!rawCustomerId || !coachId || !totalPrice || !bookingDate || !bookingTime) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: '必須項目が不足しています',
          received: { rawCustomerId, coachId, totalPrice, bookingDate, bookingTime },
        }),
      };
    }

    // ============================================
    // 3. customerId を customers.id に解決
    //    クライアントから渡される ID は auth user ID または customers.id のどちらか
    //    bookings.customer_id への FK 制約は customers.id を要求するため
    //    ここで必ず customers.id に変換する
    //    【2026/5/21 拡張】email も取得して、後段の members 引き当てに使用
    // ============================================
    let customer = null;
    const { data: cust, error: custErr } = await supabase
      .from('customers')
      .select('id, name, email, furigana, age, birth_date, is_approved, user_id')
      .or(`id.eq.${rawCustomerId},user_id.eq.${rawCustomerId}`)
      .maybeSingle();

    if (custErr) {
      console.error('[create-booking-request] customer lookup error:', custErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'customer lookup failed', detail: custErr.message }),
      };
    }

    if (!cust) {
      console.error('[create-booking-request] customer not found for id/user_id:', rawCustomerId);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'お客様情報が見つかりません。会員認証を完了してから再度お試しください。',
          received: { rawCustomerId },
        }),
      };
    }

    customer = cust;
    const customerId = cust.id; // ← bookings.customer_id へ入れる正しい値
    console.log('[create-booking-request] resolved customerId:', customerId, '(from input:', rawCustomerId, ')');

    // ============================================
    // 4. bookings へ pending_approval で INSERT
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
        status:        'pending_approval',
        agreed_terms:  agreedTerms,
        customer_name: customerNameInput,
        coach_name:    coachName,
        // 【2026/5/24 CP4 追加】クーポン情報
        coupon_id:        couponId,
        coupon_code:      couponCode,
        original_price:   originalPrice,
        discount_amount:  discountAmount,
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
    // 4.5 クーポン使用記録(2026/5/24 CP4 追加)
    // ============================================
    if (couponId) {
      try {
        // coupon_usages へ記録
        const { error: usageErr } = await supabase
          .from('coupon_usages')
          .insert({
            coupon_id:        couponId,
            booking_id:       bookingId,
            customer_id:      customerId,
            discount_amount:  discountAmount,
            used_at:          new Date().toISOString(),
          });
        if (usageErr) {
          console.warn('[create-booking-request] coupon_usages insert warn:', usageErr.message);
        }

        // coupons.used_count をインクリメント
        const { data: currentCoupon } = await supabase
          .from('coupons')
          .select('used_count')
          .eq('id', couponId)
          .single();
        if (currentCoupon) {
          const newCount = (currentCoupon.used_count || 0) + 1;
          await supabase
            .from('coupons')
            .update({ used_count: newCount, updated_at: new Date().toISOString() })
            .eq('id', couponId);
          console.log('[create-booking-request] coupon used_count incremented to', newCount);
        }
      } catch (e) {
        console.warn('[create-booking-request] coupon recording warn:', e.message);
      }
    }

    // ============================================
    // 5. コーチ情報を取得(line_user_id 取得のため)
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
    // 6. 店舗情報を取得(line_user_id 取得のため)
    // ============================================
    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .select('id, name, line_user_id')
      .eq('store_key', storeKey)
      .maybeSingle();

    if (storeErr) {
      console.error('[create-booking-request] store fetch error:', storeErr);
    }

    // ============================================
    // 7. 【2026/5/21 新規】members テーブルから plan_name を取得
    //    お客様のメール + store_key + is_active=true で引き当て
    //    店舗向けオレンジカードの「プラン」欄に表示する
    // ============================================
    let planName = null;
    try {
      const customerEmail = customer?.email ? String(customer.email).toLowerCase().trim() : null;
      if (customerEmail && storeKey) {
        const { data: memberRow, error: memberErr } = await supabase
          .from('members')
          .select('plan_name')
          .eq('store_key', storeKey)
          .eq('email', customerEmail)
          .eq('is_active', true)
          .maybeSingle();
        if (memberErr) {
          console.error('[create-booking-request] members fetch error:', memberErr);
        } else if (memberRow && memberRow.plan_name) {
          planName = memberRow.plan_name;
        }
        console.log('[create-booking-request] plan_name lookup:', { customerEmail, storeKey, planName });
      } else {
        console.log('[create-booking-request] plan_name lookup skipped (no email or store_key)');
      }
    } catch (e) {
      console.error('[create-booking-request] plan_name lookup exception:', e);
    }

    // ============================================
    // 8. 共通パラメータ準備
    // ============================================
    const storeName = STORE_KEY_TO_NAME[storeKey] || store?.name || storeKey;
    const dateStr = formatDateJa(bookingDate);
    const timeStr = bookingTime ? bookingTime.substring(0, 5) : '';
    const lessonLabel = LESSON_TYPE_LABEL[lessonType] || lessonType;
    const displayCustomerName = customer?.name || customerNameInput || 'お客様';
    const displayCoachName = coach?.name || coachName || 'コーチ';
    const customerFurigana = customer?.furigana || null;
    const isApproved = !!customer?.is_approved;

    // 年齢計算:birth_date 優先、なければ age カラム
    let customerAge = null;
    if (customer?.birth_date) {
      customerAge = calcAge(customer.birth_date);
    } else if (customer?.age) {
      customerAge = customer.age;
    }

    // ============================================
    // 9. コーチのLINEへFlex Message送信(緑カード)
    // ============================================
    if (coach?.line_user_id) {
      const flexContent = buildApprovalRequestFlex({
        bookingId,
        customerName: displayCustomerName,
        lessonType: lessonLabel,
        dateStr,
        timeStr,
        storeName,
        amount: totalPrice,
      });

      const altText = buildApprovalRequestText({
        coachName: displayCoachName,
        customerName: displayCustomerName,
        lessonType: lessonLabel,
        dateStr,
        timeStr,
        storeName,
        amount: totalPrice,
      });

      const pushResult = await pushFlexMessage(
        coach.line_user_id,
        altText,
        flexContent
      );

      console.log('[create-booking-request] coach flex push result:', pushResult);

      if (!pushResult.ok) {
        console.warn('[create-booking-request] コーチへのLINE通知失敗ですが予約は作成済み');
      }
    } else {
      console.warn('[create-booking-request] coach has no line_user_id:', coachId);
    }

    // ============================================
    // 10. 店舗のLINEへFlex Message送信(オレンジカード)
    //     【2026/5/21 更新】planName を渡す
    // ============================================
    if (store?.line_user_id) {
      const storeFlex = buildStorePendingRequestFlex({
        customerName: displayCustomerName,
        customerFurigana,
        customerAge,
        isApproved,
        planName,
        coachName: displayCoachName,
        lessonType: lessonLabel,
        dateStr,
        timeStr,
        storeName,
        amount: totalPrice,
      });

      const storeAltText = `📩 予約申込が入りました - ${displayCustomerName}様 / ${dateStr}`;

      const storePushResult = await pushFlexMessage(
        store.line_user_id,
        storeAltText,
        storeFlex
      );

      console.log('[create-booking-request] store flex push result:', storePushResult);

      if (!storePushResult.ok) {
        console.warn('[create-booking-request] 店舗へのLINE通知失敗ですが予約は作成済み');
      }
    } else {
      console.warn('[create-booking-request] store has no line_user_id:', storeKey);
    }

    // ============================================
    // 11. お客様画面に結果返却
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
        store_notified: !!store?.line_user_id,
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
