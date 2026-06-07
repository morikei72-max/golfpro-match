// netlify/functions/customer-line-login.js
// 【お客様のLINEログイン一本化】
// LINEアクセストークンで本人を確実に確認し(なりすまし防止)、
//   ・初めての人  → お客様アカウントと会員情報を自動作成
//   ・登録済みの人 → そのお客様アカウントを呼び出す
// その上で、Supabaseのログイン用トークン(token_hash)を発行して画面に返す。
// ※このファイルは customers テーブルのみを操作し、coaches には一切関与しない。
// ※決済・通知の既存関数(line-webhook.js / line-notify.js 等)には触れていない。

const { createClient } = require('@supabase/supabase-js');

const STORE_KEY = 'tozuike';

exports.handler = async (event) => {
  // CORSヘッダー(既存 liff-link-process.js と同じ方針)
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
    const { access_token } = JSON.parse(event.body || '{}');

    if (!access_token) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'アクセストークンがありません' })
      };
    }

    // 1) LINEアクセストークンで本人確認(なりすまし防止)
    //    画面から送られた access_token を使い、LINE側に「この人は誰か」を直接問い合わせる。
    //    これにより、他人のLINE IDを偽って送ってもログインできない。
    const profRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: 'Bearer ' + access_token }
    });

    if (!profRes.ok) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: 'LINE本人確認に失敗しました' })
      };
    }

    const profile = await profRes.json();
    const lineUserId = profile.userId;
    const displayName = profile.displayName || 'お客様';

    if (!lineUserId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: 'LINEユーザー情報を取得できませんでした' })
      };
    }

    // 2) Supabase接続(Service Role)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 3) このLINEに紐づくお客様を検索
    const { data: existing, error: selErr } = await supabase
      .from('customers')
      .select('id, user_id, email, name, is_approved')
      .eq('line_user_id', lineUserId)
      .maybeSingle();

    if (selErr) {
      console.error('[customer-line-login] select error:', selErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, error: '検索に失敗しました' })
      };
    }

    let authEmail;
    let isNew = false;

    if (existing && existing.user_id) {
      // 登録済みの人 → そのアカウントのメールを取得してログインさせる
      const { data: gu, error: guErr } = await supabase.auth.admin.getUserById(existing.user_id);
      if (guErr || !gu || !gu.user) {
        console.error('[customer-line-login] getUserById error:', guErr);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ success: false, error: 'アカウント取得に失敗しました' })
        };
      }
      authEmail = gu.user.email;

    } else {
      // 初めての人 → アカウントと会員情報を自動作成
      isNew = true;
      // 画面には見えない内部用のメール(LINEユーザーIDから一意に決まる。実際の通知はLINEで行う)
      authEmail = lineUserId.toLowerCase() + '@line.mycoach.app';

      const { data: created, error: cErr } = await supabase.auth.admin.createUser({
        email: authEmail,
        email_confirm: true,
        user_metadata: {
          login_provider: 'line',
          line_user_id: lineUserId,
          display_name: displayName
        }
      });

      if (cErr || !created || !created.user) {
        console.error('[customer-line-login] createUser error:', cErr);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ success: false, error: 'アカウント作成に失敗しました' })
        };
      }

      const newUserId = created.user.id;

      // customers に最小限の会員行を作成(本名・電話などは後でプロフィールから追加できる)
      const { error: insErr } = await supabase
        .from('customers')
        .insert({
          user_id: newUserId,
          email: authEmail,
          name: displayName,
          line_user_id: lineUserId,
          store_key: STORE_KEY,
          is_approved: true
        });

      if (insErr) {
        console.error('[customer-line-login] insert customers error:', insErr);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ success: false, error: '会員情報の作成に失敗しました' })
        };
      }
    }

    // 4) ログイン用トークン(token_hash)を発行
    //    メールは送らず、ログインに使う token_hash だけをサーバー内部で発行する。
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: authEmail
    });

    if (linkErr || !linkData || !linkData.properties || !linkData.properties.hashed_token) {
      console.error('[customer-line-login] generateLink error:', linkErr);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, error: 'ログイン発行に失敗しました' })
      };
    }

    console.log(`[customer-line-login] ${isNew ? 'NEW' : 'EXISTING'} customer login: ${lineUserId} (${displayName})`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        token_hash: linkData.properties.hashed_token,
        is_new: isNew,
        display_name: displayName
      })
    };

  } catch (e) {
    console.error('[customer-line-login] Error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: e.message || 'サーバーエラー' })
    };
  }
};
