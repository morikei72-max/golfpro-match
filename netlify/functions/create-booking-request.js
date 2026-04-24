// create-booking-request.js
const { createClient } = require('@supabase/supabase-js');
const { 
  pushFlexMessage, 
  buildApprovalRequestFlex, 
  buildApprovalRequestText,
  formatDateJa
} = require('./line-notify');

exports.handler = async (event) => {
  // 1. CORS処理
  // 2. POSTのみ受付
  // 3. パラメータ受取(既存のcreate-checkout-session.jsと同じ構造)
  // 4. bookings INSERT (status='pending_approval')
  // 5. コーチのline_user_id取得
  // 6. Flex Message構築・送信
  // 7. 結果をお客様画面に返却
};
