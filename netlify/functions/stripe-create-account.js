const Stripe = require('stripe');

exports.handler = async (event) => {
  // CORS対応
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // OPTIONSリクエスト(プリフライト)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // POSTのみ受け付ける
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { email, coach_id, coach_name } = JSON.parse(event.body);

    // 必須項目チェック
    if (!email || !coach_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'email と coach_id は必須です' })
      };
    }

    // Stripe Expressアカウントを作成
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'JP',
      email: email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_type: 'individual',
      metadata: {
        coach_id: coach_id,
        coach_name: coach_name || ''
      }
    });

    // 登録用リンクを作成
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://soft-speculoos-5ef188.netlify.app/coach.html?stripe_refresh=true',
      return_url: 'https://soft-speculoos-5ef188.netlify.app/coach.html?stripe_return=true',
      type: 'account_onboarding'
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        account_id: account.id,
        onboarding_url: accountLink.url
      })
    };

  } catch (error) {
    console.error('Stripe account creation error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message || 'アカウント作成に失敗しました'
      })
    };
  }
};
