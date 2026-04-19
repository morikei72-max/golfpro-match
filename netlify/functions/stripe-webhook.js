// netlify/functions/stripe-webhook.js
// MyCoach Stripe Webhook（MASTER_DB.md 準拠・2026/4/19）
// bookings 実カラムのみ使用: status のみ UPDATE する

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Netlify Functions で raw body を受けるため
exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    // Netlify は event.body を base64 で渡す場合がある
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log('Stripe event received:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {
      // ============================================
      // 決済完了
      // ============================================
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const bookingId = session.metadata?.booking_id;

        if (bookingId) {
          const { error } = await supabase
            .from('bookings')
            .update({ status: 'confirmed' })
            .eq('id', bookingId);

          if (error) {
            console.error('bookings update (confirmed) error:', error);
          } else {
            console.log('Booking confirmed:', bookingId);
            // LINE通知（line-notify.js がある場合に備えて try-catch）
            await notifyLineSafely('booking_confirmed', { bookingId, session });
          }
        }
        break;
      }

      // ============================================
      // 決済失敗
      // ============================================
      case 'checkout.session.expired':
      case 'payment_intent.payment_failed': {
        const session = stripeEvent.data.object;
        const bookingId = session.metadata?.booking_id;

        if (bookingId) {
          const { error } = await supabase
            .from('bookings')
            .update({ status: 'payment_failed' })
            .eq('id', bookingId);

          if (error) console.error('bookings update (payment_failed) error:', error);
          else console.log('Booking payment_failed:', bookingId);
        }
        break;
      }

      // ============================================
      // 返金
      // ============================================
      case 'charge.refunded': {
        const charge = stripeEvent.data.object;
        const bookingId = charge.metadata?.booking_id;

        if (bookingId) {
          const { error } = await supabase
            .from('bookings')
            .update({ status: 'refunded' })
            .eq('id', bookingId);

          if (error) console.error('bookings update (refunded) error:', error);
          else console.log('Booking refunded:', bookingId);
        }
        break;
      }

      // ============================================
      // Stripe Connect アカウント更新（コーチの入金可能状態同期）
      // ============================================
      case 'account.updated': {
        const account = stripeEvent.data.object;
        const { error } = await supabase
          .from('coaches')
          .update({
            stripe_charges_enabled:   account.charges_enabled,
            stripe_payouts_enabled:   account.payouts_enabled,
            stripe_details_submitted: account.details_submitted,
          })
          .eq('stripe_account_id', account.id);

        if (error) console.error('coaches update (account.updated) error:', error);
        else console.log('Coach Stripe status synced:', account.id);
        break;
      }

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('stripe-webhook handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// ============================================
// LINE通知（line-notify.js があれば呼ぶ。なくてもエラーにしない）
// ============================================
async function notifyLineSafely(kind, payload) {
  try {
    const mod = require('./line-notify.js');
    if (typeof mod.notify === 'function') {
      await mod.notify(kind, payload);
    }
  } catch (e) {
    // line-notify.js が無い、または内部エラー。Webhook 自体は成功させる。
    console.warn('LINE notify skipped:', e.message);
  }
}
