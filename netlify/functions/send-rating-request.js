// netlify/functions/send-rating-request.js
// MyCoach 評価依頼LINE自動送信(Phase 2 ④)
// 【2026/5/23 新規】レッスン翌日にお客様LINEへ評価依頼Flex Message送信
//
// 動作:
//   毎日 日本時間 14:00(UTC 5:00)に Scheduled Functions として自動実行
//   ↓
//   bookings から以下を満たすレコードを抽出:
//     - status = 'confirmed'(決済確定済)
//     - booking_date = 昨日(JST)
//     - rating_request_sent_at IS NULL(未送信)
//   ↓
//   各予約について:
//     - 既に同じコーチを評価済の場合はスキップ(お一人様1コーチ1回ルール)
//     - お客様LINEに評価依頼Flex Message送信
//     - bookings.rating_request_sent_at に now() を記録
//
// 重要原則:
//   - line-webhook.js / line-notify.js は 1 行も変更しない(require のみ)
//   - 既存LINEカードのデザインを踏襲(MyCoach緑系)
//
// 環境変数:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   LINE_CHANNEL_ACCESS_TOKEN(line-notify経由で使用)

const { createClient } = require('@supabase/supabase-js');
const { pushFlexMessage } = require('./line-notify');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BASE_URL = 'https://soft-speculoos-5ef188.netlify.app';

const LESSON_TYPE_LABEL = {
  indoor: 'インドアゴルフレッスン',
  round: 'ラウンドレッスン',
  accompany: '同伴ラウンド',
  comp: 'コンペ参加',
  custom: 'コーチ独自プラン',
};

// ============================================
// 評価依頼Flex Message ビルダー(MyCoach緑系・既存LINEカードと統一感)
// ============================================
function buildRatingRequestFlex({ customerName, coachName, lessonType, dateStr, ratingUrl }) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#064D3B',
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: '⭐ レッスン評価のお願い',
          color: '#FFFFFF',
          weight: 'bold',
          size: 'lg',
          align: 'center',
        },
        {
          type: 'text',
          text: 'MyCoach',
          color: '#65CEA5',
          size: 'xs',
          align: 'center',
          margin: 'sm',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: `${customerName}様`,
          weight: 'bold',
          size: 'md',
          color: '#064D3B',
          wrap: true,
        },
        {
          type: 'text',
          text: '昨日のレッスンはいかがでしたか?',
          size: 'sm',
          color: '#333333',
          wrap: true,
          margin: 'sm',
        },
        {
          type: 'separator',
          margin: 'md',
        },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          margin: 'md',
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                { type: 'text', text: 'コーチ', size: 'xs', color: '#6b8a78', flex: 2 },
                { type: 'text', text: `${coachName} コーチ`, size: 'sm', color: '#064D3B', weight: 'bold', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                { type: 'text', text: '内容', size: 'xs', color: '#6b8a78', flex: 2 },
                { type: 'text', text: lessonType, size: 'sm', color: '#064D3B', weight: 'bold', flex: 5, wrap: true },
              ],
            },
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                { type: 'text', text: '日付', size: 'xs', color: '#6b8a78', flex: 2 },
                { type: 'text', text: dateStr, size: 'sm', color: '#064D3B', weight: 'bold', flex: 5 },
              ],
            },
          ],
        },
        {
          type: 'separator',
          margin: 'md',
        },
        {
          type: 'text',
          text: '皆様のご評価がコーチの励みになります。1分ほどで完了します。',
          size: 'xs',
          color: '#6b8a78',
          wrap: true,
          margin: 'md',
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#1D9E75',
          height: 'md',
          action: {
            type: 'uri',
            label: '⭐ 評価する',
            uri: ratingUrl,
          },
        },
      ],
    },
  };
}

function formatDateJa(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(s => parseInt(s, 10));
  const wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}(${wd})`;
}

// ============================================
// メインハンドラ
// ============================================
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  console.log('[send-rating-request] Started at:', new Date().toISOString());

  try {
    // 昨日(日本時間)の日付を計算
    const nowUtc = new Date();
    const jstOffsetMs = 9 * 60 * 60 * 1000;
    const nowJst = new Date(nowUtc.getTime() + jstOffsetMs);
    nowJst.setUTCDate(nowJst.getUTCDate() - 1);
    const yesterdayJstStr = nowJst.toISOString().substring(0, 10); // YYYY-MM-DD

    console.log('[send-rating-request] target date (JST yesterday):', yesterdayJstStr);

    // 対象予約抽出
    const { data: bookings, error: fetchErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('status', 'confirmed')
      .eq('booking_date', yesterdayJstStr)
      .is('rating_request_sent_at', null);

    if (fetchErr) {
      console.error('[send-rating-request] bookings fetch error:', fetchErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: fetchErr.message }),
      };
    }

    const targets = bookings || [];
    console.log('[send-rating-request] candidate bookings:', targets.length);

    if (targets.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          message: '送信対象なし',
          processed: 0,
        }),
      };
    }

    let sentCount = 0;
    let skippedCount = 0;
    let failCount = 0;
    const results = [];

    for (const b of targets) {
      try {
        const customerKey = b.customer_id;
        const coachKey = b.coach_id;

        if (!customerKey || !coachKey) {
          results.push({ booking_id: b.id, status: 'skip', reason: 'no customer/coach' });
          skippedCount++;
          continue;
        }

        // ============================================
        // 二重評価防止1:同じコーチへ既に評価済の場合スキップ
        // (お一人様1コーチ1回ルール)
        // ============================================
        const { data: existingRating } = await supabase
          .from('coach_ratings')
          .select('id')
          .eq('coach_id', coachKey)
          .eq('customer_id', customerKey)
          .limit(1)
          .maybeSingle();

        if (existingRating) {
          // 既に評価済 → 送信スキップ + sent_atのみ記録(再判定不要にする)
          await supabase
            .from('bookings')
            .update({ rating_request_sent_at: new Date().toISOString() })
            .eq('id', b.id);
          results.push({ booking_id: b.id, status: 'skip', reason: 'already rated this coach' });
          skippedCount++;
          continue;
        }

        // ============================================
        // 二重評価防止2:このコーチ宛に既に評価依頼を送ったbookingがあるならスキップ
        // (例:過去のレッスンで評価依頼送信済だが未評価のケース)
        // ============================================
        const { data: alreadyRequested } = await supabase
          .from('bookings')
          .select('id')
          .eq('coach_id', coachKey)
          .eq('customer_id', customerKey)
          .not('rating_request_sent_at', 'is', null)
          .neq('id', b.id)
          .limit(1)
          .maybeSingle();

        if (alreadyRequested) {
          await supabase
            .from('bookings')
            .update({ rating_request_sent_at: new Date().toISOString() })
            .eq('id', b.id);
          results.push({ booking_id: b.id, status: 'skip', reason: 'already requested for this coach' });
          skippedCount++;
          continue;
        }

        // ============================================
        // お客様情報取得
        // ============================================
        const { data: customer } = await supabase
          .from('customers')
          .select('id, name, line_user_id')
          .or(`id.eq.${customerKey},user_id.eq.${customerKey}`)
          .maybeSingle();

        if (!customer?.line_user_id) {
          results.push({ booking_id: b.id, status: 'skip', reason: 'no customer line_user_id' });
          skippedCount++;
          // sent_at記録しない(LINE連携後に再送する可能性のため)
          continue;
        }

        // ============================================
        // コーチ情報取得
        // ============================================
        const { data: coach } = await supabase
          .from('coaches')
          .select('id, name')
          .eq('id', coachKey)
          .maybeSingle();

        // ============================================
        // Flex Message 構築・送信
        // ============================================
        const customerName = customer.name || b.customer_name || 'お客様';
        const coachName = coach?.name || b.coach_name || 'コーチ';
        const lessonType = LESSON_TYPE_LABEL[b.lesson_type] || b.lesson_type || 'レッスン';
        const dateStr = formatDateJa(b.booking_date);
        const ratingUrl = `${BASE_URL}/customer-rating.html?booking_id=${b.id}`;

        const flex = buildRatingRequestFlex({
          customerName,
          coachName,
          lessonType,
          dateStr,
          ratingUrl,
        });

        const altText = `⭐ ${coachName}コーチへのレッスン評価をお願いいたします`;

        await pushFlexMessage(customer.line_user_id, altText, flex);

        // 送信成功記録
        await supabase
          .from('bookings')
          .update({ rating_request_sent_at: new Date().toISOString() })
          .eq('id', b.id);

        results.push({
          booking_id: b.id,
          customer_name: customerName,
          coach_name: coachName,
          status: 'sent',
        });
        sentCount++;
      } catch (e) {
        console.error('[send-rating-request] per-booking error:', b.id, e);
        results.push({ booking_id: b.id, status: 'fail', error: e.message });
        failCount++;
      }
    }

    console.log('[send-rating-request] Completed. sent:', sentCount, 'skipped:', skippedCount, 'fail:', failCount);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        message: '評価依頼送信処理完了',
        target_date: yesterdayJstStr,
        candidates: targets.length,
        sent: sentCount,
        skipped: skippedCount,
        fail: failCount,
        results,
      }),
    };
  } catch (err) {
    console.error('[send-rating-request] handler error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
