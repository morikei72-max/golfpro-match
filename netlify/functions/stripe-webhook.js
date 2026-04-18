striconst Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // POSTのみ受け付ける
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = event.headers['stripe-signature'];

  let stripeEvent;

  // Stripeからの正当な通知かを署名で検証
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      webhookSecret
    );
  } catch (err) {
    console.error('[Webhook] 署名検証失敗:', err.message);
    return {
      statusCode: 400,
      body: `Webhook signature verification failed: ${err.message}`
    };
  }

  console.log('[Webhook] 受信イベント:', stripeEvent.type);

  // Supabase接続（SERVICE_ROLE_KEYで管理者権限）
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Stripeアカウントの状態変化イベントを処理
    if (stripeEvent.type === 'account.updated') {
      const account = stripeEvent.data.object;
      console.log('[Webhook] アカウント更新:', account.id);

      // coachesテーブルを更新
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
        return {
          statusCode: 500,
          body: JSON.stringify({ error: error.message })
        };
      }

      console.log('[Webhook] DB更新成功:', data);
    }

    // 成功レスポンス
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };

  } catch (error) {
    console.error('[Webhook] 処理エラー:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};pe-webhook.js
