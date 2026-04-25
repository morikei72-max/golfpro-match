// netlify/functions/customer-cancel-request.js
// お客様からのキャンセル申請を受け付けて自動返金を実行するAPI
// 【2026/4/25 v4】
//   ■ キャンセルポリシー(更新版):
//     - 48時間以上前    : 96.4%返金(手数料3.6%のみ控除)
//     - 48時間~当日前  : 46.4%返金(50%キャンセル料+手数料3.6%控除)
//     - 当日キャンセル  : 16.4%返金(80%キャンセル料+手数料3.6%控除)
//   ■ Stripe決済情報の取得:
//     1. Checkout Session 検索(過去の決済対応)
//     2. payment_intent.search 検索(新規決済対応・予備)
//   ■ Stripe Refund API(通常決済)で自動返金
//     → カード保有者へ直接返金
//   ■ bookings.status = 'cancelled' に更新
//   ■ 3者へLINE通知(お客様・コーチ・店舗)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { pushFlexMessage, pushMessage, formatDateJa } = require('./line-notify');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// 店舗管理者(森下啓介様)のLINE user ID
const STORE_ADMIN_LINE_USER_ID = 'U5432473c1eaf786206613f07cab3c0f7';

// レッスン種別マップ
const LESSON_TYPE_MAP = {
  indoor: 'インドアゴルフレッスン',
  round: 'ラウンドレッスン',
  accompany: '同伴ラウンド',
  comp: 'コンペ参加',
  custom: 'コーチ独自プラン',
};

// 店舗キーマップ
const STORE_KEY_MAP = {
  kyoto: 'Golf Create 戸津池店',
};

/**
 * キャンセルポリシーに基づく返金額計算
 * @param {string} bookingDate - YYYY-MM-DD
 * @param {string} bookingTime - HH:MM:SS
 * @param {number} totalPrice - 決済額
 * @returns {object} { policy, refundAmount, cancelFee, hoursUntilLesson }
 */
function calculateRefund(bookingDate, bookingTime, totalPrice) {
  const STRIPE_FEE_RATE = 0.036; // 3.6%
  const stripeFee = Math.round(totalPrice * STRIPE_FEE_RATE);

  // レッスン日時を構築
  const timeStr = (bookingTime || '00:00:00').substring(0, 8);
  const lessonDateTime = new Date(`${bookingDate}T${timeStr}+09:00`);
  const now = new Date();
  const hoursUntilLesson = (lessonDateTime - now) / (1000 * 60 * 60);

  let policy, refundAmount, cancelFee;

  if (hoursUntilLesson >= 48) {
    // 48時間以上前:96.4%返金(手数料のみ控除)
    policy = 'full_refund';
    cancelFee = stripeFee;
    refundAmount = totalPrice - stripeFee;
  } else if (hoursUntilLesson >= 24) {
    // 24時間~48時間前:46.4%返金(50%+手数料控除)
    policy = 'half_refund';
    const halfFee = Math.round(totalPrice * 0.5);
    cancelFee = halfFee + stripeFee;
    refundAmount = totalPrice - cancelFee;
  } else {
    // 24時間以内(当日含む):16.4%返金(80%+手数料控除)
    policy = 'sameday_refund';
    const eightyFee = Math.round(totalPrice * 0.8);
    cancelFee = eightyFee + stripeFee;
    refundAmount = totalPrice - cancelFee;
  }

  return { policy, refundAmount, cancelFee, hoursUntilLesson, stripeFee };
}

/**
 * Stripe Checkout Session または PaymentIntent から booking_id に対応する決済情報を検索
 * @param {string} bookingId
 * @returns {Promise<{paymentIntentId: string, sessionId: string|null}|null>}
 */
async function findStripePaymentInfo(bookingId) {
  // Method 1: Checkout Session を直近100件取得して metadata で検索
  // (古い決済でも metadata は保存されているのでヒット率が高い)
  try {
    let allSessions = [];
    let hasMore = true;
    let startingAfter = null;
    let pageCount = 0;
    const MAX_PAGES = 5; // 最大500件まで遡る

    while (hasMore && pageCount < MAX_PAGES) {
      const params = { limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;

      const result = await stripe.checkout.sessions.list(params);
      allSessions = allSessions.concat(result.data);

      hasMore = result.has_more;
      if (result.data.length > 0) {
        startingAfter = result.data[result.data.length - 1].id;
      }
      pageCount++;

      // ヒットしたら早期終了
      const hit = result.data.find(s => s.metadata?.booking_id === bookingId);
      if (hit) {
        if (hit.payment_intent) {
          console.log('[cancel-request] Method1 hit (Checkout Session):', hit.id, 'PI:', hit.payment_intent);
          return { paymentIntentId: hit.payment_intent, sessionId: hit.id };
        }
      }
    }

    // 全件検索後にもヒットしない
    const found = allSessions.find(s => s.metadata?.booking_id === bookingId);
    if (found && found.payment_intent) {
      console.log('[cancel-request] Method1 hit (full scan):', found.id);
      return { paymentIntentId: found.payment_intent, sessionId: found.id };
    }
  } catch (e) {
    console.error('[cancel-request] Method1 error:', e.message);
  }

  // Method 2: PaymentIntent Search API(新規決済で metadata 付与済みの場合)
  try {
    const searchResult = await stripe.paymentIntents.search({
      query: `metadata['booking_id']:'${bookingId}' AND status:'succeeded'`,
      limit: 1,
    });
    if (searchResult.data && searchResult.data.length > 0) {
      const pi = searchResult.data[0];
      console.log('[cancel-request] Method2 hit (PaymentIntent search):', pi.id);
      return { paymentIntentId: pi.id, sessionId: null };
    }
  } catch (e) {
    console.error('[cancel-request] Method2 error:', e.message);
  }

  return null;
}

exports.handler = async (event) => {
  // CORS対応
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
    const { booking_id, reason_category, reason_text } = body;

    // バリデーション
    if (!booking_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'booking_id is required' }),
      };
    }
    if (!reason_category) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'キャンセル理由を選択してください' }),
      };
    }
    if (!reason_text || reason_text.trim().length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'キャンセル理由の詳細を入力してください' }),
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 予約取得
    const { data: booking, error: bookingErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .maybeSingle();

    if (bookingErr || !booking) {
      console.error('[cancel-request] booking fetch error:', bookingErr);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ ok: false, error: '予約が見つかりませんでした' }),
      };
    }

    // ステータス確認(confirmed のみキャンセル可能)
    if (booking.status !== 'confirmed') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          ok: false,
          error: 'このご予約は現在キャンセルできる状態ではありません',
          current_status: booking.status,
        }),
      };
    }

    const totalPrice = parseInt(booking.total_price) || 0;

    // 返金額計算
    const refundCalc = calculateRefund(booking.booking_date, booking.booking_time, totalPrice);
    const { policy, refundAmount, cancelFee, hoursUntilLesson } = refundCalc;

    console.log('[cancel-request] refund calc:', {
      bookingId: booking_id,
      totalPrice,
      hoursUntilLesson: hoursUntilLesson.toFixed(1),
      policy,
      cancelFee,
      refundAmount,
    });

    // ============================================
    // Stripe API で自動返金実行(返金額>0の場合のみ)
    // ============================================
    let refundResult = null;
    let stripePaymentIntentId = null;

    if (refundAmount > 0) {
      try {
        // Stripe決済情報を検索
        const paymentInfo = await findStripePaymentInfo(booking_id);

        if (!paymentInfo) {
          console.error('[cancel-request] Stripe payment info not found for booking:', booking_id);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              ok: false,
              error: '決済情報が見つかりませんでした。店舗までご連絡ください',
            }),
          };
        }

        stripePaymentIntentId = paymentInfo.paymentIntentId;
        console.log('[cancel-request] PaymentIntent found:', stripePaymentIntentId);

        // 返金実行(通常決済・カード保有者へ直接返金)
        refundResult = await stripe.refunds.create({
          payment_intent: stripePaymentIntentId,
          amount: refundAmount,
          metadata: {
            booking_id: booking_id,
            cancel_policy: policy,
            cancel_fee: String(cancelFee),
            cancel_reason_category: reason_category,
          },
        });

        console.log('[cancel-request] refund created:', refundResult.id, 'amount:', refundResult.amount);
      } catch (stripeErr) {
        console.error('[cancel-request] Stripe refund error:', stripeErr);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            ok: false,
            error: '返金処理でエラーが発生しました。店舗までご連絡ください',
            detail: stripeErr.message,
          }),
        };
      }
    }

    // ============================================
    // bookings 更新
    // ============================================
    const cancelTimestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const policyLabel = policy === 'full_refund' ? '全額返金(48時間以上前)'
                      : policy === 'half_refund' ? '50%返金(24~48時間前)'
                      : '20%返金(24時間以内・当日)';
    const cancelNote = `【キャンセル完了】\n申請日時:${cancelTimestamp}\nカテゴリ:${reason_category}\n詳細:${reason_text.trim()}\n適用ポリシー:${policyLabel}\n決済額:¥${totalPrice.toLocaleString()}\nキャンセル料:¥${cancelFee.toLocaleString()}\n返金額:¥${refundAmount.toLocaleString()}` +
      (refundResult ? `\nStripe Refund ID:${refundResult.id}` : '');
    const newComment = booking.comment ? `${booking.comment}\n\n${cancelNote}` : cancelNote;

    const { error: updateErr } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        comment: newComment,
      })
      .eq('id', booking_id);

    if (updateErr) {
      console.error('[cancel-request] bookings update error:', updateErr);
    }

    // ============================================
    // 通知用情報の取得
    // ============================================
    let coachName = booking.coach_name || 'コーチ';
    let coachLineUserId = null;
    if (booking.coach_id) {
      const { data: coach } = await supabase
        .from('coaches')
        .select('name, line_user_id')
        .eq('id', booking.coach_id)
        .maybeSingle();
      if (coach?.name) coachName = coach.name;
      if (coach?.line_user_id) coachLineUserId = coach.line_user_id;
    }

    let customerName = booking.customer_name || 'お客様';
    let customerLineUserId = null;
    if (booking.customer_id) {
      const { data: customer } = await supabase
        .from('customers')
        .select('name, line_user_id')
        .eq('id', booking.customer_id)
        .maybeSingle();
      if (customer?.name) customerName = customer.name;
      if (customer?.line_user_id) customerLineUserId = customer.line_user_id;
    }

    const lessonType = LESSON_TYPE_MAP[booking.lesson_type] || booking.lesson_type || 'レッスン';
    const dateStr = booking.booking_date ? formatDateJa(booking.booking_date) : '—';
    const timeStr = booking.booking_time ? booking.booking_time.substring(0, 5) : '';
    const storeName = STORE_KEY_MAP[booking.store_key] || booking.store_key || '—';
    const minutesStr = booking.minutes ? `${booking.minutes}分` : '';

    // ============================================
    // ① お客様へLINE通知(キャンセル完了・返金処理済み)
    // ============================================
    if (customerLineUserId) {
      const customerFlex = buildCustomerCancelCompleteFlex({
        customerName, coachName, lessonType, minutesStr,
        dateStr, timeStr, storeName, totalPrice, cancelFee, refundAmount, policy,
      });
      const customerAlt = `✅ キャンセル完了 / 返金額 ¥${refundAmount.toLocaleString()}`;
      await pushFlexMessage(customerLineUserId, customerAlt, customerFlex);
      console.log('[cancel-request] customer notified');
    }

    // ============================================
    // ② コーチへLINE通知(キャンセル発生・情報共有)
    // ============================================
    if (coachLineUserId) {
      const coachFlex = buildCoachCancelNoticeFlex({
        coachName, customerName, lessonType, minutesStr,
        dateStr, timeStr, storeName, totalPrice, refundAmount, reason_category, reason_text,
      });
      const coachAlt = `📢 キャンセル発生 / ${customerName}様 / ${dateStr}`;
      await pushFlexMessage(coachLineUserId, coachAlt, coachFlex);
      console.log('[cancel-request] coach notified');
    }

    // ============================================
    // ③ 店舗(森下啓介様)へLINE通知
    //   ※ コーチと店舗が同一LINEの場合は重複送信を回避
    // ============================================
    if (STORE_ADMIN_LINE_USER_ID && STORE_ADMIN_LINE_USER_ID !== coachLineUserId) {
      const adminFlex = buildAdminCancelNoticeFlex({
        customerName, coachName, lessonType, minutesStr,
        dateStr, timeStr, storeName, totalPrice, cancelFee, refundAmount,
        reason_category, reason_text, policy, refundId: refundResult?.id,
      });
      const adminAlt = `📢 キャンセル処理完了 / ${customerName}様 / 返金 ¥${refundAmount.toLocaleString()}`;
      await pushFlexMessage(STORE_ADMIN_LINE_USER_ID, adminAlt, adminFlex);
      console.log('[cancel-request] admin notified');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        message: 'キャンセル処理が完了しました',
        booking_id,
        policy,
        cancel_fee: cancelFee,
        refund_amount: refundAmount,
        refund_id: refundResult?.id || null,
      }),
    };
  } catch (e) {
    console.error('[cancel-request] error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'サーバーエラー', detail: e.message }),
    };
  }
};

// ============================================
// LINE Flex Message テンプレート
// ============================================

/**
 * お客様向け:キャンセル完了通知(緑カード)
 */
function buildCustomerCancelCompleteFlex({
  customerName, coachName, lessonType, minutesStr,
  dateStr, timeStr, storeName, totalPrice, cancelFee, refundAmount, policy,
}) {
  const policyText = policy === 'full_refund' ? '48時間以上前のキャンセル(全額返金)'
                    : policy === 'half_refund' ? '24~48時間前のキャンセル(50%返金)'
                    : '24時間以内のキャンセル(20%返金)';

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#2E7D32',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '✅ キャンセル完了のお知らせ', color: '#FFFFFF', weight: 'bold', size: 'lg' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: `${customerName}様`, weight: 'bold', size: 'md', color: '#222222' },
        { type: 'text', text: 'ご予約のキャンセルが完了しました。', size: 'sm', color: '#555555', margin: 'sm' },
        { type: 'separator', margin: 'md' },
        {
          type: 'text', text: '【キャンセルされた予約】',
          color: '#2E7D32', weight: 'bold', size: 'sm', margin: 'md',
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            _flexRow('コーチ', coachName),
            _flexRow('種別', `${lessonType}${minutesStr ? ' / ' + minutesStr : ''}`),
            _flexRow('日時', `${dateStr} ${timeStr}`.trim()),
            _flexRow('場所', storeName),
          ],
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'text', text: '【返金内容】',
          color: '#2E7D32', weight: 'bold', size: 'sm', margin: 'md',
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            _flexRow('適用ポリシー', policyText),
            _flexRow('決済額', `¥${totalPrice.toLocaleString()}`),
            _flexRow('キャンセル料', `¥${cancelFee.toLocaleString()}`),
            _flexRow('返金額', `¥${refundAmount.toLocaleString()}`),
          ],
        },
        { type: 'separator', margin: 'lg' },
        {
          type: 'text',
          text: '返金は数日以内にご利用のクレジットカードへ反映されます',
          size: 'xs', color: '#555555', wrap: true, margin: 'md', align: 'center',
        },
      ],
    },
  };
}

/**
 * コーチ向け:キャンセル発生通知(オレンジカード)
 */
function buildCoachCancelNoticeFlex({
  coachName, customerName, lessonType, minutesStr,
  dateStr, timeStr, storeName, totalPrice, refundAmount, reason_category, reason_text,
}) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#E65100',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '📢 予約キャンセルのお知らせ', color: '#FFFFFF', weight: 'bold', size: 'lg' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: `${coachName}様`, weight: 'bold', size: 'md', color: '#222222' },
        { type: 'text', text: '以下の予約がキャンセルされました', size: 'sm', color: '#555555', margin: 'sm' },
        { type: 'separator', margin: 'md' },
        {
          type: 'text', text: '【お客様情報】',
          color: '#E65100', weight: 'bold', size: 'sm', margin: 'md',
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            _flexRow('お客様', `${customerName}様`),
          ],
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'text', text: '【予約内容】',
          color: '#E65100', weight: 'bold', size: 'sm', margin: 'md',
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            _flexRow('種別', `${lessonType}${minutesStr ? ' / ' + minutesStr : ''}`),
            _flexRow('日時', `${dateStr} ${timeStr}`.trim()),
            _flexRow('場所', storeName),
            _flexRow('金額', `¥${totalPrice.toLocaleString()}`),
          ],
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'text', text: '【キャンセル理由】',
          color: '#E65100', weight: 'bold', size: 'sm', margin: 'md',
        },
        {
          type: 'text', text: reason_category, size: 'sm', color: '#222222', weight: 'bold',
        },
        {
          type: 'text', text: reason_text, size: 'sm', color: '#555555', wrap: true, margin: 'sm',
        },
        { type: 'separator', margin: 'lg' },
        {
          type: 'text', text: '※返金処理は自動完了しています。対応は不要です',
          size: 'xs', color: '#555555', wrap: true, margin: 'md', align: 'center',
        },
      ],
    },
  };
}

/**
 * 店舗向け:キャンセル発生通知(青カード・詳細情報入り)
 */
function buildAdminCancelNoticeFlex({
  customerName, coachName, lessonType, minutesStr,
  dateStr, timeStr, storeName, totalPrice, cancelFee, refundAmount,
  reason_category, reason_text, policy, refundId,
}) {
  const policyLabel = policy === 'full_refund' ? '全額返金(48時間以上前)'
                    : policy === 'half_refund' ? '50%返金(24~48時間前)'
                    : '20%返金(24時間以内・当日)';

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#1565C0',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: '📢 キャンセル処理完了(店舗管理)', color: '#FFFFFF', weight: 'bold', size: 'lg' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'text', text: '【お客様情報】',
          color: '#1565C0', weight: 'bold', size: 'sm',
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            _flexRow('お客様', `${customerName}様`),
            _flexRow('コーチ', coachName),
          ],
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'text', text: '【予約内容】',
          color: '#1565C0', weight: 'bold', size: 'sm', margin: 'md',
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            _flexRow('種別', `${lessonType}${minutesStr ? ' / ' + minutesStr : ''}`),
            _flexRow('日時', `${dateStr} ${timeStr}`.trim()),
            _flexRow('場所', storeName),
          ],
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'text', text: '【返金処理結果】',
          color: '#1565C0', weight: 'bold', size: 'sm', margin: 'md',
        },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            _flexRow('適用ポリシー', policyLabel),
            _flexRow('決済額', `¥${totalPrice.toLocaleString()}`),
            _flexRow('キャンセル料', `¥${cancelFee.toLocaleString()}`),
            _flexRow('返金額', `¥${refundAmount.toLocaleString()}`),
          ],
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'text', text: '【キャンセル理由】',
          color: '#1565C0', weight: 'bold', size: 'sm', margin: 'md',
        },
        {
          type: 'text', text: reason_category, size: 'sm', color: '#222222', weight: 'bold',
        },
        {
          type: 'text', text: reason_text, size: 'sm', color: '#555555', wrap: true, margin: 'sm',
        },
        { type: 'separator', margin: 'lg' },
        {
          type: 'text',
          text: 'カード保有者へ自動返金完了',
          size: 'xs', color: '#555555', wrap: true, margin: 'md', align: 'center',
        },
      ],
    },
  };
}

function _flexRow(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: '#666666', size: 'sm', flex: 2 },
      { type: 'text', text: String(value || '—'), wrap: true, color: '#222222', size: 'sm', flex: 5 },
    ],
  };
}
