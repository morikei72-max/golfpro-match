// netlify/functions/customer-cancel-request.js
// お客様からのキャンセル申請を受け付けるAPI
// 【2026/4/25 新規作成】
//   - 決済済み予約のキャンセル申請を受け付け
//   - bookings.status を 'cancel_requested' に更新
//   - 森下啓介様(店舗管理者)にLINE通知
//   - 返金処理は森下啓介様がStripeダッシュボードで手動実行

const { createClient } = require('@supabase/supabase-js');
const { pushFlexMessage, formatDateJa } = require('./line-notify');

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

    // Supabase クライアント
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
          error: 'このご予約は現在キャンセル申請できる状態ではありません',
          current_status: booking.status,
        }),
      };
    }

    // コーチ情報取得
    let coachName = booking.coach_name || 'コーチ';
    if (booking.coach_id) {
      const { data: coach } = await supabase
        .from('coaches')
        .select('name')
        .eq('id', booking.coach_id)
        .maybeSingle();
      if (coach?.name) coachName = coach.name;
    }

    // お客様情報取得
    let customerName = booking.customer_name || 'お客様';
    if (booking.customer_id) {
      const { data: customer } = await supabase
        .from('customers')
        .select('name')
        .eq('id', booking.customer_id)
        .maybeSingle();
      if (customer?.name) customerName = customer.name;
    }

    // 既存コメントに「【キャンセル理由】」を追記
    const cancelNote = `【キャンセル理由】\nカテゴリ:${reason_category}\n詳細:${reason_text.trim()}\n申請日時:${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;
    const newComment = booking.comment
      ? `${booking.comment}\n\n${cancelNote}`
      : cancelNote;

    // bookings 更新
    const { error: updateErr } = await supabase
      .from('bookings')
      .update({
        status: 'cancel_requested',
        comment: newComment,
      })
      .eq('id', booking_id);

    if (updateErr) {
      console.error('[cancel-request] update error:', updateErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: 'キャンセル申請の保存に失敗しました', detail: updateErr.message }),
      };
    }

    // LINE通知用データ準備
    const totalPrice = parseInt(booking.total_price) || 0;
    const cancelFee = Math.round(totalPrice * 0.036); // 3.6%
    const refundAmount = totalPrice - cancelFee;
    const lessonType = LESSON_TYPE_MAP[booking.lesson_type] || booking.lesson_type || 'レッスン';
    const dateStr = booking.booking_date ? formatDateJa(booking.booking_date) : '—';
    const timeStr = booking.booking_time ? booking.booking_time.substring(0, 5) : '';
    const storeName = STORE_KEY_MAP[booking.store_key] || booking.store_key || '—';
    const minutesStr = booking.minutes ? `${booking.minutes}分` : '';

    // 森下啓介様(店舗管理者)へLINE通知(Flex Message)
    const adminFlex = {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#B71C1C',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: '🚨 キャンセル申請が届きました',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '【お客様情報】',
            color: '#B71C1C',
            weight: 'bold',
            size: 'sm',
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              _flexRow('お客様', `${customerName} 様`),
              _flexRow('コーチ', coachName),
            ],
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '【予約内容】',
            color: '#B71C1C',
            weight: 'bold',
            size: 'sm',
            margin: 'md',
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              _flexRow('種別', `${lessonType}${minutesStr ? ' / ' + minutesStr : ''}`),
              _flexRow('日時', `${dateStr} ${timeStr}`.trim()),
              _flexRow('場所', storeName),
            ],
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '【返金計算】',
            color: '#B71C1C',
            weight: 'bold',
            size: 'sm',
            margin: 'md',
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              _flexRow('決済額', `¥${totalPrice.toLocaleString()}`),
              _flexRow('手数料(3.6%)', `¥${cancelFee.toLocaleString()}`),
              _flexRow('返金予定額', `¥${refundAmount.toLocaleString()}`),
            ],
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '【キャンセル理由】',
            color: '#B71C1C',
            weight: 'bold',
            size: 'sm',
            margin: 'md',
          },
          {
            type: 'text',
            text: `${reason_category}`,
            size: 'sm',
            color: '#222222',
            weight: 'bold',
          },
          {
            type: 'text',
            text: reason_text.trim(),
            size: 'sm',
            color: '#555555',
            wrap: true,
            margin: 'sm',
          },
          { type: 'separator', margin: 'lg' },
          {
            type: 'text',
            text: '▼ 対応手順',
            color: '#B71C1C',
            weight: 'bold',
            size: 'sm',
            margin: 'md',
          },
          {
            type: 'text',
            text: '1. Stripeダッシュボードで返金処理\n2. お客様にLINEで返金完了通知',
            size: 'xs',
            color: '#555555',
            wrap: true,
            margin: 'sm',
          },
        ],
      },
    };

    const adminAlt = `🚨 キャンセル申請: ${customerName}様 / ${dateStr} / 返金予定 ¥${refundAmount.toLocaleString()}`;
    const pushResult = await pushFlexMessage(STORE_ADMIN_LINE_USER_ID, adminAlt, adminFlex);
    console.log('[cancel-request] admin LINE push:', pushResult);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        message: 'キャンセル申請を受け付けました',
        booking_id,
        cancel_fee: cancelFee,
        refund_amount: refundAmount,
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

function _flexRow(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      {
        type: 'text',
        text: label,
        color: '#666666',
        size: 'sm',
        flex: 2,
      },
      {
        type: 'text',
        text: String(value || '—'),
        wrap: true,
        color: '#222222',
        size: 'sm',
        flex: 5,
      },
    ],
  };
}
