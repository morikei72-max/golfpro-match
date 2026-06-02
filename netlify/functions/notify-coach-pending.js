// netlify/functions/notify-coach-pending.js
// 【2026/6/2 新規】コーチが登録(利用規約同意)を完了した時、
//   店舗(本部)へ「認証待ち」をLINE通知する。
//   - line-notify.js の pushFlexMessage を再利用(line-notify.js は一切変更しない)
//   - 認証/却下ボタン付き(postback action=approve_coach / reject_coach)
//   - ボタン押下の処理は line-webhook.js 側で行う

const { createClient } = require('@supabase/supabase-js');
const { pushFlexMessage } = require('./line-notify');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const coachUserId = body.coach_user_id || null; // auth.users.id (= coaches.user_id)
    const coachId = body.coach_id || null;          // coaches.id (どちらか一方でよい)

    if (!coachUserId && !coachId) {
      return ok({ ok: false, error: 'no_coach_identifier' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // コーチ取得
    let query = supabase
      .from('coaches')
      .select('id, name, store_key, line_user_id, is_approved, is_rejected');
    query = coachId ? query.eq('id', coachId) : query.eq('user_id', coachUserId);

    const { data: coach, error: coachErr } = await query.maybeSingle();

    if (coachErr || !coach) {
      console.error('[notify-coach-pending] coach fetch error:', coachErr);
      return ok({ ok: false, error: 'coach_not_found' });
    }

    // 店舗(本部)取得
    let store = null;
    if (coach.store_key) {
      const { data, error: storeErr } = await supabase
        .from('stores')
        .select('id, name, line_user_id')
        .eq('store_key', coach.store_key)
        .maybeSingle();
      if (storeErr) console.error('[notify-coach-pending] store fetch error:', storeErr);
      store = data;
    }

    if (!store || !store.line_user_id) {
      console.log('[notify-coach-pending] store has no line_user_id, skip');
      return ok({ ok: false, skipped: true, reason: 'no_store_line_user_id' });
    }

    const coachName = coach.name || 'コーチ';
    const storeName = store.name || coach.store_key || '—';

    const flex = buildCoachPendingFlex({ coachId: coach.id, coachName, storeName });
    const result = await pushFlexMessage(
      store.line_user_id,
      `📩 新規コーチ 認証待ち - ${coachName}様`,
      flex
    );
    console.log('[notify-coach-pending] push result:', result);

    return ok({ ok: true });
  } catch (err) {
    console.error('[notify-coach-pending] error:', err);
    return ok({ ok: false, error: err.message });
  }
};

function ok(obj) {
  return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify(obj) };
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function buildCoachPendingFlex({ coachId, coachName, storeName }) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#F57C00',
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: '📩 新規コーチ 認証待ち',
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
          text: '【店舗管理者様】',
          color: '#F57C00',
          weight: 'bold',
          size: 'sm',
        },
        {
          type: 'text',
          text: '新しいコーチが登録し、認証をお待ちしています。',
          size: 'sm',
          color: '#555555',
          margin: 'sm',
          wrap: true,
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            flexRow('コーチ', `${coachName} 様`),
            flexRow('店舗', storeName),
          ],
        },
        { type: 'separator', margin: 'lg' },
        {
          type: 'text',
          text: '内容をご確認の上、下のボタンで認証または却下してください',
          size: 'xs',
          color: '#888888',
          margin: 'md',
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#2E7D32',
          action: {
            type: 'postback',
            label: '✅ 認証する',
            data: `action=approve_coach&coach_id=${coachId}`,
            displayText: 'コーチを認証しました',
          },
        },
        {
          type: 'button',
          style: 'secondary',
          action: {
            type: 'postback',
            label: '❌ 却下する',
            data: `action=reject_coach&coach_id=${coachId}`,
            displayText: 'コーチを却下します',
          },
        },
      ],
    },
  };
}

function flexRow(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: '#666666', size: 'sm', flex: 2 },
      { type: 'text', text: String(value || '—'), wrap: true, color: '#222222', size: 'sm', flex: 5 },
    ],
  };
}
