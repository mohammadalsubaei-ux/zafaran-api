// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  زعفران — تحديثات ذرّية للأرصدة والعدّادات
//
//  تستدعي دوال قاعدة البيانات من migrations/2026-09-25_atomic_wallets.sql.
//  إن لم تُنشأ الدوال بعد (أو لا صلاحية)، ترجع للطريقة القديمة (قراءة ثم كتابة)
//  حتى لا يتعطل شيء قبل تشغيل ملف SQL.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const supabase = require('./supabase')

// الدالة غير موجودة أو غير مسموحة — نستخدم البديل
function rpcUnavailable(error) {
  const code = String(error?.code || '')
  // 22P02: نوع المعرّف في القاعدة ليس uuid كما تتوقعه الدوال — البديل أسلم من فشل كل ترصيد
  return code === 'PGRST202' || code === '42883' || code === '42501' || code === '22P02' ||
    /could not find the function/i.test(String(error?.message || ''))
}

let warned = false
async function tryRpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args)
  if (!error) return { ok: true, data }
  if (rpcUnavailable(error)) {
    if (!warned) {
      warned = true
      console.warn('[atomic] DB functions not installed — using fallback. Run migrations/2026-09-25_atomic_wallets.sql')
    }
    return { ok: false }
  }
  throw error
}

// إضافة مبلغ (أو خصمه إن كان سالباً) للرصيد والمتاح
async function walletAdd(wallet, amount) {
  const r = await tryRpc('wallet_add', { p_wallet_id: wallet.id, p_amount: amount })
  if (r.ok) return

  const { error } = await supabase
    .from('wallets')
    .update({
      balance: Number(wallet.balance || 0) + amount,
      available_balance: Number(wallet.available_balance || 0) + amount
    })
    .eq('id', wallet.id)
  if (error) throw error
}

// خصم سحب — يرجع false إن لم يكفِ الرصيد المتاح
async function walletWithdraw(wallet, amount) {
  const r = await tryRpc('wallet_withdraw', { p_wallet_id: wallet.id, p_amount: amount })
  if (r.ok) return r.data === true

  if (Number(wallet.available_balance || 0) < amount) return false
  const { error } = await supabase
    .from('wallets')
    .update({
      available_balance: Number(wallet.available_balance || 0) - amount,
      balance: Number(wallet.balance || 0) - amount
    })
    .eq('id', wallet.id)
  if (error) throw error
  return true
}

// عدّاد استخدام العرض (+1 عند الطلب، -1 عند الإلغاء)
async function offerUsageAdd(offerId, delta, currentCount) {
  const r = await tryRpc('offer_usage_add', { p_offer_id: offerId, p_delta: delta })
  if (r.ok) return

  const next = Math.max(0, Number(currentCount || 0) + delta)
  const { error } = await supabase
    .from('offers')
    .update({ usage_count: next })
    .eq('id', offerId)
  if (error) throw error
}

module.exports = { walletAdd, walletWithdraw, offerUsageAdd }
