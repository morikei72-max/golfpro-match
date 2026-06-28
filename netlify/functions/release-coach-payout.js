// netlify/functions/release-coach-payout.js
// MyCoach コーチへの送金実行関数(エスクロー方式)
// 【2026/5/23 v2】コーチ完了ボタン不要・レッスン日+7日経過で自動送金
// 【2026/6/28 v3】故障A修正:
//   auto_complete_past_bookings(DB側cron)がレッスン翌日に status を
//   'confirmed' → 'completed' に変えるため、送金期日(レッスン日+7日)には
//   既に 'completed' になっており、status='confirmed' 限定では永久に拾えず
//   送金が止まっていた。送金対象に 'completed' も含める。
//   ※ payout_status='pending' + payout_eligible_at<=now(NULLは除外) +
//      payout_amount>0 の3重ガードは維持。未決済・返金・キャンセルは拾わない。
//
// 動作:
//   bookings テーブルから以下を満たすレコードを抽出:
//     - status in ('confirmed','completed')(決済確定済かつキャンセル/返金でない)
//     - payout_status = 'pending'(未送金)
//     - payout_eligible_at <= now()(レッスン日+7日経過)
//   ↓
//   各レコードについて Stripe transfers.create() でコーチへ送金
//   ↓
//   bookings.payout_status = 'released' に更新
//   bookings.payout_transfer_id = transfer.id に記録
//   bookings.payout_released_at = now() に記録
//
// 呼び出し方法:
//   ① Netlify Scheduled Functions(日次cron JST 2:00)から自動呼び出し
//   ② Netlify Functions URL に GET/POSTでアクセスして手動実行
//
// 環境変数:
//   STRIPE_SECRET_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  console.log('[release-coach-payout] Started at:', new Date().toISOString());

  try {
    // ============================================
    // 送金対象の bookings を抽出
    // ============================================
    const nowIso = new Date().toISOString();

    const { data: targets, error: selectErr } = await supabase
      .from('bookings')
      .select('id, coach_id, total_price, payout_amount, payout_eligible_at, booking_date, booking_time, lesson_type, customer_name, coach_name')
      .in('status', ['confirmed', 'completed'])
      .eq('payout_status', 'pending')
      .lte('payout_eligible_at', nowIso);

    if (selectErr) {
      console.error('[release-coach-payout] select error:', selectErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: 'bookings select failed', detail: selectErr.message }),
      };
    }

    console.log('[release-coach-payout] target count:', targets?.length || 0);

    if (!targets || targets.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, message: '送金対象の予約はありませんでした', processed: 0 }),
      };
    }

    // ============================================
    // 各レコードについて送金実行
    // ============================================
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (const booking of targets) {
      const bookingId = booking.id;
      const coachId = booking.coach_id;
      const payoutAmount = parseInt(booking.payout_amount, 10);

      if (!coachId) {
        console.error('[release-coach-payout] coach_id missing for booking:', bookingId);
        results.push({ booking_id: bookingId, ok: false, error: 'coach_id missing' });
        failCount++;
        continue;
      }

      if (!payoutAmount || payoutAmount <= 0) {
        console.error('[release-coach-payout] invalid payout_amount for booking:', bookingId, 'amount:', payoutAmount);
        results.push({ booking_id: bookingId, ok: false, error: 'invalid payout_amount' });
        failCount++;
        continue;
      }

      // コーチのStripe Connect アカウントIDを取得
      const { data: coach, error: coachErr } = await supabase
        .from('coaches')
        .select('stripe_account_id, stripe_payouts_enabled')
        .eq('id', coachId)
        .maybeSingle();

      if (coachErr || !coach) {
        console.error('[release-coach-payout] coach not found:', coachId, coachErr);
        results.push({ booking_id: bookingId, ok: false, error: 'coach not found' });
        failCount++;
        continue;
      }

      if (!coach.stripe_account_id) {
        console.error('[release-coach-payout] coach stripe_account_id missing:', coachId);
        results.push({ booking_id: bookingId, ok: false, error: 'coach stripe_account_id missing' });
        failCount++;
        continue;
      }

      // Stripe transfers.create で送金実行
      try {
        const transfer = await stripe.transfers.create({
          amount: payoutAmount,
          currency: 'jpy',
          destination: coach.stripe_account_id,
          description: `MyCoach payout for booking ${bookingId}`,
          metadata: {
            booking_id: bookingId,
            coach_id: coachId,
            lesson_type: booking.lesson_type || '',
            booking_date: booking.booking_date || '',
            booking_time: booking.booking_time || '',
            customer_name: booking.customer_name || '',
            coach_name: booking.coach_name || '',
          },
        });

        console.log('[release-coach-payout] transfer created:', transfer.id, 'amount:', payoutAmount, 'to:', coach.stripe_account_id);

        // bookings 更新
        const { error: updateErr } = await supabase
          .from('bookings')
          .update({
            payout_status: 'released',
            payout_transfer_id: transfer.id,
            payout_released_at: new Date().toISOString(),
          })
          .eq('id', bookingId);

        if (updateErr) {
          console.error('[release-coach-payout] bookings update error after transfer:', bookingId, updateErr);
          results.push({
            booking_id: bookingId,
            ok: false,
            error: 'bookings update failed after transfer',
            transfer_id: transfer.id,
            detail: updateErr.message,
          });
          failCount++;
          continue;
        }

        results.push({
          booking_id: bookingId,
          ok: true,
          transfer_id: transfer.id,
          amount: payoutAmount,
          coach_stripe_account_id: coach.stripe_account_id,
        });
        successCount++;
      } catch (stripeErr) {
        console.error('[release-coach-payout] stripe transfer error:', bookingId, stripeErr.message);
        results.push({
          booking_id: bookingId,
          ok: false,
          error: 'stripe transfer failed',
          detail: stripeErr.message,
        });
        failCount++;
      }
    }

    console.log('[release-coach-payout] Completed. success:', successCount, 'fail:', failCount);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        message: '送金処理が完了しました',
        processed: targets.length,
        success: successCount,
        fail: failCount,
        results,
      }),
    };
  } catch (err) {
    console.error('[release-coach-payout] handler error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
