const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const {
  pushMessage,
  buildBookingConfirmedText,
  buildPaymentCompletedText,
  buildCoachNewBookingText,
  buildCancellationText,
} = require('./line-notify');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = event.headers['stripe-signature'];

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('[Webhook] 署名検証失敗:', err.message);
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  console.log('[Webhook] 受信イベント:', stripeEvent.type);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // ===== 既存：account.updated（コーチのStripe登録ステータス同期）=====
    if (stripeEvent.type === 'account.updated') {
      const account = stripeEvent.data.object;
      console.log('[Webhook] アカウント更新:', account.id,
        'charges=', account.charges_enabled,
        'payouts=', account.payouts_enabled,
        'details=', account.details_submitted);

      const { data, error } = await supabase
        .from('coaches')
        .update({
          stripe_charges_enabled: account.charges_enabled || false,
          stripe_payouts_enabled: account.payouts_enabled || false,
          stripe_details_submitted: account.details_submitted || false,
          updated_at: new Date().toISOString()
        })
        .eq('stripe_account_id', account.id)
        .select();

      if (error) {
        console.error('[Webhook] DB更新エラー:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      }

      console.log('[Webhook] DB更新成功:', data ? data.length : 0, '件');
    }

    // ===== 新規：checkout.session.completed（お客様決済完了）=====
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;
      const meta = session.metadata || {};
      const bookingId = meta.booking_id;
      const amount = session.amount_total || 0;

      console.log('[Webhook] 決済完了:', session.id, 'booking_id=', bookingId, 'amount=', amount);

      if (bookingId) {
        // bookingsのstatusをconfirmedに更新
        const { data: updated, error: upErr } = await supabase
          .from('bookings')
          .update({
            status: 'confirmed',
            stripe_payment_intent_id: session.payment_intent || null,
            paid_at: new Date().toISOString(),
          })
          .eq('id', bookingId)
          .select()
          .single();

        if (upErr) {
          console.error('[Webhook] bookings更新エラー:', upErr);
        } else {
          console.log('[Webhook] bookings確定:', bookingId);

          // ===== LINE通知（お客様 + コーチ）=====
          await sendLineNotifications(supabase, updated, amount);
        }
      }
    }

    // ===== 新規：payment_intent.succeeded（ログのみ）=====
    if (stripeEvent.type === 'payment_intent.succeeded') {
      const pi = stripeEvent.data.object;
      console.log('[Webhook] PaymentIntent成功:', pi.id, 'amount=', pi.amount);
    }

    // ===== 新規：payment_intent.payment_failed（決済失敗）=====
    if (stripeEvent.type === 'payment_intent.payment_failed') {
      const pi = stripeEvent.data.object;
      console.log('[Webhook] 決済失敗:', pi.id);

      // metadata経由でbookingを特定できれば failed にする
      const meta = pi.metadata || {};
      if (meta.booking_id) {
        await supabase
          .from('bookings')
          .update({ status: 'payment_failed' })
          .eq('id', meta.booking_id);
      }
    }

    // ===== 新規：charge.refunded（返金）=====
    if (stripeEvent.type === 'charge.refunded') {
      const charge = stripeEvent.data.object;
      console.log('[Webhook] 返金:', charge.id);

      const meta = charge.metadata || {};
      if (meta.booking_id) {
        const { data: refunded } = await supabase
          .from('bookings')
          .update({ status: 'refunded', refunded_at: new Date().toISOString() })
          .eq('id', meta.booking_id)
          .select()
          .single();

        // キャンセル通知
        if (refunded) {
          await sendCancellationNotifications(supabase, refunded);
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (error) {
    console.error('[Webhook] 処理エラー:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

// ===================================================================
// LINE通知ヘルパー
// ===================================================================

async function sendLineNotifications(supabase, booking, amountYen) {
  try {
    // 1. お客様情報取得
    let customerName = 'お客様';
    let customerLineId = null;
    if (booking.customer_user_id) {
      const { data: customer } = await supabase
        .from('customers')
        .select('name, line_user_id')
        .eq('user_id', booking.customer_user_id)
        .maybeSingle();
      if (customer) {
        customerName = customer.name || customerName;
        customerLineId = customer.line_user_id;
      }
    }

    // 2. コーチ情報取得
    let coachName = '';
    let coachLineId = null;
    if (booking.coach_id) {
      const { data: coach } = await supabase
        .from('coaches')
        .select('name, line_user_id')
        .eq('id', booking.coach_id)
        .maybeSingle();
      if (coach) {
        coachName = coach.name || '';
        coachLineId = coach.line_user_id;
      }
    }

    // 3. 表示用整形
    const lessonTypeLabels = {
      indoor: 'インドアゴルフレッスン',
      round: 'ラウンドレッスン',
      accompany: '同伴ラウンド',
      comp: 'コンペ参加',
    };
    const storeLabels = { kyoto: 'Golf Create 京都店', fushimi: 'Golf Create 伏見店' };

    const common = {
      customerName,
      coachName,
      lessonType: lessonTypeLabels[booking.lesson_type] || booking.lesson_type,
      dateStr: booking.lesson_date || '',
      timeStr: booking.lesson_time || '',
      storeName: storeLabels[booking.store_key] || '',
      amount: amountYen,
    };

    // 4. お客様へ通知
    if (customerLineId) {
      await pushMessage(customerLineId, buildBookingConfirmedText(common));
      await pushMessage(customerLineId, buildPaymentCompletedText({ customerName, amount: amountYen }));
    } else {
      console.log('[line] customer has no line_user_id, skip');
    }

    // 5. コーチへ通知（手取り計算：段階1では概算値）
    if (coachLineId) {
      // 段階1の概算：店舗10% + 本部10% + Stripe手数料3.6% を引いた額
      const coachAmount = Math.floor(amountYen * 0.764);
      await pushMessage(
        coachLineId,
        buildCoachNewBookingText({ ...common, coachAmount })
      );
    } else {
      console.log('[line] coach has no line_user_id, skip');
    }

  } catch (e) {
    console.error('[line] sendLineNotifications error:', e);
  }
}

async function sendCancellationNotifications(supabase, booking) {
  try {
    let customerName = 'お客様';
    let customerLineId = null;
    if (booking.customer_user_id) {
      const { data: customer } = await supabase
        .from('customers')
        .select('name, line_user_id')
        .eq('user_id', booking.customer_user_id)
        .maybeSingle();
      if (customer) {
        customerName = customer.name || customerName;
        customerLineId = customer.line_user_id;
      }
    }

    let coachName = '';
    let coachLineId = null;
    if (booking.coach_id) {
      const { data: coach } = await supabase
        .from('coaches')
        .select('name, line_user_id')
        .eq('id', booking.coach_id)
        .maybeSingle();
      if (coach) {
        coachName = coach.name || '';
        coachLineId = coach.line_user_id;
      }
    }

    const text = buildCancellationText({
      customerName,
      coachName,
      dateStr: booking.lesson_date || '',
      timeStr: booking.lesson_time || '',
    });

    if (customerLineId) await pushMessage(customerLineId, text);
    if (coachLineId) await pushMessage(coachLineId, text);
  } catch (e) {
    console.error('[line] sendCancellationNotifications error:', e);
  }
}
