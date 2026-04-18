const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { email, coach_id, coach_name } = JSON.parse(event.body);

    if (!email || !coach_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'email と coach_id は必須です' })
      };
    }

    const { data: coach, error: fetchError } = await supabase
      .from('coaches')
      .select('stripe_account_id')
      .eq('user_id', coach_id)
      .maybeSingle();

    if (fetchError) {
      console.error('[create-account] coach取得エラー:', fetchError);
    }

    let accountId = coach && coach.stripe_account_id ? coach.stripe_account_id : null;

    if (accountId) {
      try {
        const existing = await stripe.accounts.retrieve(accountId);

        if (existing.charges_enabled && existing.payouts_enabled && existing.details_submitted) {
          await supabase.from('coaches').update({
            stripe_charges_enabled: true,
            stripe_payouts_enabled: true,
            stripe_details_submitted: true,
            updated_at: new Date().toISOString()
          }).eq('user_id', coach_id);

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              already_completed: true,
              account_id: accountId
            })
          };
        }
      } catch (e) {
        console.warn('[create-account] 既存アカウント取得失敗、新規作成にフォールバック:', e.message);
        accountId = null;
      }
    }

    if (!accountId) {
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
      accountId = account.id;

      await supabase.from('coaches').update({
        stripe_account_id: accountId,
        stripe_charges_enabled: false,
        stripe_payouts_enabled: false,
        stripe_details_submitted: false,
        updated_at: new Date().toISOString()
      }).eq('user_id', coach_id);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'https://soft-speculoos-5ef188.netlify.app/coach.html?stripe_refresh=true',
      return_url: 'https://soft-speculoos-5ef188.netlify.app/coach.html?stripe_return=true',
      type: 'account_onboarding'
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        account_id: accountId,
        onboarding_url: accountLink.url
      })
    };

  } catch (error) {
    console.error('[create-account] エラー:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'アカウント作成に失敗しました' })
    };
  }
};
