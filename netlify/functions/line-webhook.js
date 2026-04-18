// netlify/functions/line-webhook.js
// LINE公式アカウント「MyCoach」からのWebhookを受け取る
// 主な役割：
//   1. 友だち追加時に line_user_id を Supabase に保存する準備
//   2. ユーザーからのメッセージをログ（将来拡張用）
//   3. LINE側の署名検証（セキュリティ）

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // CORS & OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Line-Signature',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Netlifyのbase64対応
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

    // 署名検証
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const signature = event.headers['x-line-signature'] || event.headers['X-Line-Signature'];

    if (channelSecret && signature) {
      const hash = crypto
        .createHmac('sha256', channelSecret)
        .update(rawBody)
        .digest('base64');
      if (hash !== signature) {
        console.error('LINE signature mismatch');
        return { statusCode: 401, body: 'Invalid signature' };
      }
    }

    const body = JSON.parse(rawBody);
    const events = body.events || [];

    // Supabase クライアント（Service Role Key使用）
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    for (const ev of events) {
      const lineUserId = ev.source && ev.source.userId;
      if (!lineUserId) continue;

      // 1. 友だち追加イベント
      if (ev.type === 'follow') {
        console.log('New follower:', lineUserId);
        // 現時点では line_user_id 未紐付け状態で保留
        // ユーザーがアプリ内で「LINE連携する」を押した時に紐付け
      }

      // 2. 友だちブロック（解除）
      if (ev.type === 'unfollow') {
        console.log('Unfollow:', lineUserId);
        // 既存の紐付けがあればクリア
        await supabase
          .from('customers')
          .update({ line_user_id: null })
          .eq('line_user_id', lineUserId);
        await supabase
          .from('coaches')
          .update({ line_user_id: null })
          .eq('line_user_id', lineUserId);
      }

      // 3. メッセージ受信（将来拡張）
      if (ev.type === 'message') {
        console.log('Message from', lineUserId, ':', ev.message && ev.message.text);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    console.error('line-webhook error:', err);
    return {
      statusCode: 200, // LINEに再送させないため200を返す
      body: JSON.stringify({ ok: false, error: err.message })
    };
  }
};
