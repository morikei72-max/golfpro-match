// netlify/functions/import-hacomono-csv.js
// hacomono会員CSV取り込み機能 v1.0
// 仕様:store_key='tozuike' の既存レコード全削除 → CSV新規投入 → 退会者のis_approved=false

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async function(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: false, error: 'Method Not Allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const csvText = body.csv_text || '';
    
    if (!csvText) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: false, error: 'CSVデータが空です' })
      };
    }

    // CSV解析
    const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: false, error: 'CSVに有効なデータがありません(ヘッダーのみまたは空)' })
      };
    }

    // ヘッダー行をパース
    const headers = parseCsvLine(lines[0]);
    
    // 必要な列のインデックスを特定
    const colIndex = {
      member_number: headers.indexOf('会員番号'),
      email: headers.indexOf('メールアドレス'),
      plan_name: headers.indexOf('契約プラン名')
    };

    // 必須列の検証
    const missingCols = [];
    if (colIndex.member_number < 0) missingCols.push('会員番号');
    if (colIndex.email < 0) missingCols.push('メールアドレス');
    if (colIndex.plan_name < 0) missingCols.push('契約プラン名');
    
    if (missingCols.length > 0) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ 
          ok: false, 
          error: 'CSVに必須列が見つかりません: ' + missingCols.join(', ')
        })
      };
    }

    // データ行をパース
    const newMembers = [];
    const errors = [];
    
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const memberNumber = (cells[colIndex.member_number] || '').trim();
      const email = (cells[colIndex.email] || '').trim().toLowerCase();
      const planName = (cells[colIndex.plan_name] || '').trim();
      
      // メールアドレスが空の場合はスキップ(会員番号は持たない人もいる可能性)
      if (!email) {
        errors.push(`行${i + 1}: メールアドレスが空のためスキップ`);
        continue;
      }
      
      newMembers.push({
        store_key: 'tozuike',
        email: email,
        member_number: memberNumber,
        member_type: planName,  // 互換性のため
        plan_name: planName,
        is_active: true
      });
    }

    if (newMembers.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ 
          ok: false, 
          error: '有効なメンバーデータがありません',
          parse_errors: errors
        })
      };
    }

    // Supabase接続(SERVICE_ROLE で全権限)
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 既存データ削除前に、現在のメンバーemailリストを取得(退会者特定用)
    const { data: existingMembers, error: fetchErr } = await sb
      .from('members')
      .select('email')
      .eq('store_key', 'tozuike');
    
    if (fetchErr) {
      console.error('既存メンバー取得エラー', fetchErr);
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: false, error: '既存データの取得に失敗: ' + fetchErr.message })
      };
    }

    const existingEmails = new Set((existingMembers || []).map(m => (m.email || '').toLowerCase()));
    const newEmails = new Set(newMembers.map(m => m.email));
    
    // 退会者リスト(既存にあって、新CSVにいない会員)
    const removedEmails = [];
    existingEmails.forEach(email => {
      if (email && !newEmails.has(email)) {
        removedEmails.push(email);
      }
    });

    // 既存レコードを全削除(store_key='tozuike' のみ)
    const { error: delErr } = await sb
      .from('members')
      .delete()
      .eq('store_key', 'tozuike');
    
    if (delErr) {
      console.error('既存削除エラー', delErr);
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: false, error: '既存データ削除に失敗: ' + delErr.message })
      };
    }

    // 新規データを batch insert(50件ずつ)
    const BATCH = 50;
    let insertedCount = 0;
    const insertErrors = [];
    
    for (let i = 0; i < newMembers.length; i += BATCH) {
      const batch = newMembers.slice(i, i + BATCH);
      const { error: insErr } = await sb.from('members').insert(batch);
      if (insErr) {
        console.error('挿入エラー(バッチ' + (i / BATCH + 1) + ')', insErr);
        insertErrors.push('バッチ' + (i / BATCH + 1) + ': ' + insErr.message);
        // 1件ずつリトライ
        for (const rec of batch) {
          try {
            const { error: e } = await sb.from('members').insert(rec);
            if (!e) insertedCount++;
          } catch (_) { /* skip */ }
        }
      } else {
        insertedCount += batch.length;
      }
    }

    // 退会者のcustomers.is_approvedをfalseに戻す
    let revokedCount = 0;
    if (removedEmails.length > 0) {
      // customers テーブルから該当email を持つレコードを更新
      const { data: revokedData, error: revokeErr } = await sb
        .from('customers')
        .update({ 
          is_approved: false, 
          updated_at: new Date().toISOString() 
        })
        .in('email', removedEmails)
        .select('id');
      
      if (revokeErr) {
        console.error('退会者認証取り消しエラー', revokeErr);
      } else {
        revokedCount = (revokedData || []).length;
      }
    }

    return {
      statusCode: 200,
      headers: { 
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ok: true,
        message: '会員データを取り込みました',
        stats: {
          csv_rows: newMembers.length,
          inserted: insertedCount,
          removed_count: removedEmails.length,
          revoked_customers: revokedCount,
          parse_warnings: errors.length
        },
        parse_errors: errors.slice(0, 10),  // 最大10件まで返す
        insert_errors: insertErrors.slice(0, 5)
      })
    };

  } catch (e) {
    console.error('import-hacomono-csv 例外', e);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: false, error: 'サーバーエラー: ' + e.message })
    };
  }
};

// CSV1行をパース(タブ区切り対応・カンマ区切り対応・ダブルクォート対応)
function parseCsvLine(line) {
  // hacomonoはタブ区切りで出力する可能性が高い
  if (line.indexOf('\t') >= 0) {
    return line.split('\t').map(c => c.trim());
  }
  
  // カンマ区切りでダブルクォート対応のパース
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}
