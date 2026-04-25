// netlify/functions/generate-link-code.js
// 連携コード発行API
// お客様・コーチのLINE連携用6桁コードを生成する

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // CORS対応
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const { user_type, user_id } = JSON.parse(event.body || '{}');

    // バリデーション
    if (!user_type || !user_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'user_type と user_id は必須です' 
        })
      };
    }

    if (!['customer', 'coach'].includes(user_type)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'user_type は customer または coach を指定してください' 
        })
      };
    }

    // Supabaseクライアント(service_roleで接続)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ユーザー存在確認
    const tableName = user_type === 'customer' ? 'customers' : 'coaches';
    const { data: userData, error: userError } = await supabase
      .from(tableName)
      .select('id, line_user_id')
      .eq('id', user_id)
      .single();

    if (userError || !userData) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          error: 'ユーザーが見つかりません' 
        })
      };
    }

    // 既にLINE連携済みの場合
    if (userData.line_user_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: '既にLINE連携が完了しています',
          already_linked: true
        })
      };
    }

    // 既存の未使用コードを無効化(上書き方式)
    await supabase
      .from('verification_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_type', user_type)
      .eq('user_id', user_id)
      .is('used_at', null);

    // 新しい6桁コードを生成(衝突対策付き)
    let code;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      // 100000-999999 の6桁数字
      code = String(Math.floor(100000 + Math.random() * 900000));

      // 既存の未使用コードと衝突しないか確認
      const { data: existing } = await supabase
        .from('verification_codes')
        .select('id')
        .eq('code', code)
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

      if (!existing) break;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'コード生成に失敗しました。時間をおいて再度お試しください' 
        })
      };
    }

    // 有効期限10分
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // コードを保存
    const { error: insertError } = await supabase
      .from('verification_codes')
      .insert({
        code,
        user_type,
        user_id,
        expires_at: expiresAt
      });

    if (insertError) {
      console.error('Insert error:', insertError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          error: 'コード保存に失敗しました' 
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        code,
        expires_at: expiresAt,
        expires_in_minutes: 10
      })
    };

  } catch (error) {
    console.error('generate-link-code error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'サーバーエラーが発生しました',
        details: error.message 
      })
    };
  }
};
