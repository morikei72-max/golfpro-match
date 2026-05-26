// netlify/functions/liff-link-process.js
// LIFF経由でLINE連携完了後、line_user_id を DB に保存する

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // CORSヘッダー
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // プリフライト対応
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'Method not allowed' })
    };
  }

  try {
    const { user_id, user_type, line_user_id, display_name } = JSON.parse(event.body);

    if (!user_id || !user_type || !line_user_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: '必須項目が不足しています' })
      };
    }

    // Supabase接続
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // テーブル選択
    const tableName = user_type === 'customer' ? 'customers' : 'coaches';

    // 既存連携チェック(別ユーザーに同じline_user_idが紐づいていないか)
    const { data: existing } = await supabase
      .from(tableName)
      .select('id')
      .eq('line_user_id', line_user_id)
      .neq('id', user_id)
      .maybeSingle();

    if (existing) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'このLINEアカウントは既に他のユーザーに連携されています'
        })
      };
    }

    // line_user_id を保存
    const { error: updateError } = await supabase
      .from(tableName)
      .update({ line_user_id })
      .eq('id', user_id);

    if (updateError) {
      console.error('[liff-link-process] DB update error:', updateError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, error: 'データベース更新に失敗しました' })
      };
    }

    console.log(`[liff-link-process] Linked: ${user_type}/${user_id} ↔ ${line_user_id} (${display_name})`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };

  } catch (e) {
    console.error('[liff-link-process] Error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: e.message || 'サーバーエラー' })
    };
  }
};
