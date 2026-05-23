// netlify/functions/coach-dashboard-data.js
// MyCoach コーチダッシュボード集計API
// 【2026/5/23 v1】coach.html ダミーデータ撲滅のための実データ集計
//
// 動作:
//   指定された coach_id に紐づく bookings を集計し、
//   coach.html の各タブで必要なデータを1レスポンスで返す。
//
// レスポンス内容:
//   - today: 今日の予定一覧
//   - pending_approvals: 承認待ち予約一覧
//   - this_month: 今月の集計(予約数・売上・手取り)
//   - lifetime: 累計の集計(レッスン数・累計手取り・ユニーク顧客数・今月新規顧客数)
//   - lesson_type_counts: レッスン種別ごとの件数(インドア/ラウンド/同伴/コンペ/その他)
//   - income_history: 収入明細(全期間・期間フィルタはフロント側で実施)
//   - rating: レーダーチャート用集計(Phase 2 で本実装・Phase 1 はnull返却)
//
// 呼び出し方法:
//   GET /.netlify/functions/coach-dashboard-data?coach_id=xxx
//
// 既存稼働中ロジックには一切手を加えない(read-only専用)
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // coach_id を query string または body から取得
    let coachId = null;
    if (event.queryStringParameters && event.queryStringParameters.coach_id) {
      coachId = event.queryStringParameters.coach_id;
    } else if (event.body) {
      try {
        const parsed = JSON.parse(event.body);
        coachId = parsed.coach_id;
      } catch (e) {
        // body parsing失敗は無視
      }
    }

    if (!coachId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'coach_id is required' }),
      };
    }

    console.log('[coach-dashboard-data] coach_id:', coachId);

    // 日本時間ベースで「今日」「今月」を確定
    // JST = UTC + 9h
    const nowUtc = new Date();
    const jstOffsetMs = 9 * 60 * 60 * 1000;
    const nowJst = new Date(nowUtc.getTime() + jstOffsetMs);
    const todayJstStr = nowJst.toISOString().substring(0, 10); // YYYY-MM-DD (JST基準)
    const yearJst = nowJst.getUTCFullYear();
    const monthJst = nowJst.getUTCMonth() + 1; // 1-12
    const monthStartJstStr = `${yearJst}-${String(monthJst).padStart(2, '0')}-01`;
    // 翌月1日
    const nextMonthDate = new Date(Date.UTC(yearJst, monthJst, 1));
    const nextMonthStartJstStr = nextMonthDate.toISOString().substring(0, 10);

    // ============================================
    // 該当コーチの全 bookings を取得(集計はサーバ側で実行)
    // ============================================
    const { data: allBookings, error: bookingsErr } = await supabase
      .from('bookings')
      .select('*')
      .eq('coach_id', coachId)
      .order('booking_date', { ascending: false })
      .order('booking_time', { ascending: false });

    if (bookingsErr) {
      console.error('[coach-dashboard-data] bookings fetch error:', bookingsErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: 'bookings fetch failed: ' + bookingsErr.message }),
      };
    }

    const bookings = allBookings || [];
    console.log('[coach-dashboard-data] bookings count:', bookings.length);

    // ============================================
    // 1. 今日の予定(confirmed のみ)
    // ============================================
    const today = bookings
      .filter(b => b.booking_date === todayJstStr && b.status === 'confirmed')
      .sort((a, b) => (a.booking_time || '').localeCompare(b.booking_time || ''))
      .map(b => ({
        id: b.id,
        time: (b.booking_time || '').substring(0, 5), // HH:MM
        customer_name: b.customer_name || '(お客様)',
        lesson_type: b.lesson_type || 'other',
        minutes: b.minutes || 0,
        total_price: b.total_price || 0,
      }));

    // ============================================
    // 2. 承認待ち一覧
    // ============================================
    const pendingApprovals = bookings
      .filter(b => b.status === 'pending_approval')
      .sort((a, b) => {
        const dateCmp = (a.booking_date || '').localeCompare(b.booking_date || '');
        if (dateCmp !== 0) return dateCmp;
        return (a.booking_time || '').localeCompare(b.booking_time || '');
      })
      .map(b => ({
        id: b.id,
        booking_date: b.booking_date,
        booking_time: (b.booking_time || '').substring(0, 5),
        customer_name: b.customer_name || '(お客様)',
        lesson_type: b.lesson_type || 'other',
        minutes: b.minutes || 0,
        total_price: b.total_price || 0,
        comment: b.comment || '',
      }));

    // ============================================
    // 3. 今月の集計(confirmed のみ・status='confirmed'は決済確定済)
    // ============================================
    const thisMonthBookings = bookings.filter(b => {
      if (b.status !== 'confirmed') return false;
      if (!b.booking_date) return false;
      return b.booking_date >= monthStartJstStr && b.booking_date < nextMonthStartJstStr;
    });

    const thisMonth = {
      booking_count: thisMonthBookings.length,
      revenue: thisMonthBookings.reduce((sum, b) => sum + (b.total_price || 0), 0),
      payout: thisMonthBookings.reduce((sum, b) => sum + (b.payout_amount || 0), 0),
    };

    // ============================================
    // 4. 累計集計
    // ============================================
    const confirmedBookings = bookings.filter(b => b.status === 'confirmed');
    const uniqueCustomerIds = new Set(confirmedBookings.map(b => b.customer_id).filter(Boolean));

    // 今月新規顧客 = 今月confirmed予約のcustomer_idのうち、それより前にconfirmed予約のないcustomer_id
    const customerFirstBookingDate = {};
    confirmedBookings.forEach(b => {
      const cid = b.customer_id;
      if (!cid || !b.booking_date) return;
      if (!customerFirstBookingDate[cid] || b.booking_date < customerFirstBookingDate[cid]) {
        customerFirstBookingDate[cid] = b.booking_date;
      }
    });
    const newCustomersThisMonth = Object.entries(customerFirstBookingDate)
      .filter(([_, firstDate]) =>
        firstDate >= monthStartJstStr && firstDate < nextMonthStartJstStr
      ).length;

    const lifetime = {
      total_lessons: confirmedBookings.length,
      total_payout: confirmedBookings.reduce((sum, b) => sum + (b.payout_amount || 0), 0),
      unique_customers: uniqueCustomerIds.size,
      new_customers_this_month: newCustomersThisMonth,
    };

    // ============================================
    // 5. レッスン種別ごとの件数(累計・confirmed のみ)
    //    bookings.lesson_type の値: indoor / round / accompany / comp / other
    // ============================================
    const lessonTypeCounts = {
      indoor: 0,
      round: 0,
      accompany: 0,
      comp: 0,
      other: 0,
    };
    confirmedBookings.forEach(b => {
      const t = b.lesson_type || 'other';
      if (lessonTypeCounts.hasOwnProperty(t)) {
        lessonTypeCounts[t] += 1;
      } else {
        lessonTypeCounts.other += 1;
      }
    });

    // ============================================
    // 6. 収入明細(confirmed のみ・期間フィルタはフロント側で実施)
    //    送金予定日・送金状態も含めて返す
    // ============================================
    const incomeHistory = confirmedBookings.map(b => ({
      id: b.id,
      booking_date: b.booking_date,
      booking_time: (b.booking_time || '').substring(0, 5),
      customer_name: b.customer_name || '(お客様)',
      lesson_type: b.lesson_type || 'other',
      minutes: b.minutes || 0,
      total_price: b.total_price || 0,
      payout_amount: b.payout_amount || 0,
      payout_status: b.payout_status || 'pending',
      payout_eligible_at: b.payout_eligible_at || null,
      payout_released_at: b.payout_released_at || null,
    }));

    // ============================================
    // 7. レーダーチャート評価集計(Phase 2 で本実装)
    //    Phase 1 では coach_ratings テーブルが存在しないため null を返す
    //    coach.html 側は null の場合「データ蓄積中」を表示する
    // ============================================
    let rating = null;
    try {
      const { data: ratings, error: ratingErr } = await supabase
        .from('coach_ratings')
        .select('*')
        .eq('coach_id', coachId);

      if (!ratingErr && ratings && ratings.length >= 3) {
        const count = ratings.length;
        const avg = (key) => {
          const sum = ratings.reduce((s, r) => s + (r[key] || 0), 0);
          return Math.round((sum / count) * 10) / 10;
        };
        rating = {
          count,
          satisfaction: avg('rating_satisfaction'),
          value: avg('rating_value'),
          improvement: avg('rating_improvement'),
          clarity: avg('rating_clarity'),
          kindness: avg('rating_kindness'),
          rebooking: avg('rating_rebooking'),
        };
      }
    } catch (e) {
      // coach_ratings テーブル未作成時は静かに null のまま
      console.log('[coach-dashboard-data] coach_ratings not available yet (Phase 2):', e.message);
    }

    // ============================================
    // レスポンス
    // ============================================
    const responseBody = {
      ok: true,
      coach_id: coachId,
      generated_at: nowUtc.toISOString(),
      today,
      pending_approvals: pendingApprovals,
      this_month: thisMonth,
      lifetime,
      lesson_type_counts: lessonTypeCounts,
      income_history: incomeHistory,
      rating,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responseBody),
    };
  } catch (err) {
    console.error('[coach-dashboard-data] handler error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
