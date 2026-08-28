const express = require("express")
const { requireUser, assertSelf } = require('../auth')
const router = express.Router()
const supabase = require("../supabase")
const getSettings = require("../settings")
const notifyUser = require("../notify")

/**
 * Helper: Get or create wallet for user
 * Determines wallet type from user role automatically
 */
async function getOrCreateWallet(userId) {
  // Check existing
  const { data: existing } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle()

  if (existing) return existing

  // Determine role
  const { data: chefRow } = await supabase
    .from("chefs")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle()

  const { data: driverRow } = await supabase
    .from("drivers")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle()

  let walletType = "customer"
  let isWithdrawable = false
  if (chefRow) { walletType = "chef"; isWithdrawable = true }
  else if (driverRow) { walletType = "driver"; isWithdrawable = true }

  // Create
  const { data: newWallet, error } = await supabase
    .from("wallets")
    .insert({
      user_id: userId,
      wallet_type: walletType,
      is_withdrawable: isWithdrawable,
      balance: 0,
      available_balance: 0,
      pending_balance: 0,
      currency: "SAR",
    })
    .select()
    .single()

  if (error) throw error
  return newWallet
}

/**
 * GET /api/wallet/:userId
 * Returns wallet info with balances
 */
router.get("/:userId", requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.userId)) return

  try {
    const { userId } = req.params
    const wallet = await getOrCreateWallet(userId)

    const s = await getSettings()
    const { data: pendingRows } = await supabase
      .from("withdrawals")
      .select("id, amount")
      .eq("user_id", userId)
      .eq("status", "pending")
      .limit(1)
    const pendingWithdrawal = pendingRows && pendingRows[0] ? pendingRows[0] : null

    res.json({
      success: true,
      data: {
        id: wallet.id,
        wallet_type: wallet.wallet_type,
        is_withdrawable: wallet.is_withdrawable,
        available_balance: Number(wallet.available_balance || 0),
        pending_balance: Number(wallet.pending_balance || 0),
        balance: Number(wallet.balance || 0),
        currency: wallet.currency || "SAR",
        min_withdrawal_amount: Number(s.min_withdrawal_amount || 200),
        pending_withdrawal: pendingWithdrawal,
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

/**
 * GET /api/wallet/:userId/transactions
 * Returns transaction history
 */
router.get("/:userId/transactions", requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.userId)) return

  try {
    const { userId } = req.params
    const limit = parseInt(req.query.limit) || 50

    const { data, error } = await supabase
      .from("wallet_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) throw error
    res.json({ success: true, data: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

/**
 * GET /api/wallet/:userId/credit-balance
 * Returns ONLY the active (non-expired) compensation credit available for use in orders
 */
router.get("/:userId/credit-balance", requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.userId)) return

  try {
    const { userId } = req.params

    const { data, error } = await supabase
      .from("compensations")
      .select("amount_remaining")
      .eq("recipient_user_id", userId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())

    if (error) throw error

    const totalCredit = (data || []).reduce((sum, c) => sum + Number(c.amount_remaining || 0), 0)

    res.json({
      success: true,
      data: {
        available_credit: Number(totalCredit.toFixed(2)),
        compensations_count: (data || []).length,
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

/**
 * GET /api/wallet/:userId/compensations
 * Returns all compensations for user with details
 */
router.get("/:userId/compensations", requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.userId)) return

  try {
    const { userId } = req.params

    const { data, error } = await supabase
      .from("compensations")
      .select("*")
      .eq("recipient_user_id", userId)
      .order("issued_at", { ascending: false })

    if (error) throw error
    res.json({ success: true, data: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

/**
 * POST /api/wallet/:userId/use-credit
 * Use compensation credit in an order
 * Body: { order_id, amount }
 * Returns: { used_amount, remaining_compensations }
 */
router.post("/:userId/use-credit", requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.userId)) return

  try {
    const { userId } = req.params
    const { order_id, amount } = req.body

    if (!order_id || !amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "order_id و amount مطلوبان" })
    }

    // Get active compensations sorted by expiry (use the ones expiring first)
    const { data: comps, error: compErr } = await supabase
      .from("compensations")
      .select("*")
      .eq("recipient_user_id", userId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: true })

    if (compErr) throw compErr

    const totalAvailable = (comps || []).reduce((sum, c) => sum + Number(c.amount_remaining), 0)

    if (totalAvailable < amount) {
      return res.status(400).json({
        success: false,
        message: `الرصيد المتاح (${totalAvailable.toFixed(2)}) أقل من المبلغ المطلوب (${amount})`,
      })
    }

    // Deduct from compensations (oldest first)
    let remaining = Number(amount)
    const updates = []

    for (const comp of comps) {
      if (remaining <= 0) break
      const compRemaining = Number(comp.amount_remaining)
      const useFromThis = Math.min(compRemaining, remaining)
      const newUsed = Number(comp.amount_used) + useFromThis
      const newRemaining = compRemaining - useFromThis

      updates.push({
        id: comp.id,
        amount_used: newUsed,
        amount_remaining: newRemaining,
        status: newRemaining <= 0 ? "fully_used" : "active",
        fully_used_at: newRemaining <= 0 ? new Date().toISOString() : null,
      })

      remaining -= useFromThis
    }

    // Apply updates
    for (const u of updates) {
      const { error: upErr } = await supabase
        .from("compensations")
        .update({
          amount_used: u.amount_used,
          amount_remaining: u.amount_remaining,
          status: u.status,
          fully_used_at: u.fully_used_at,
        })
        .eq("id", u.id)
      if (upErr) throw upErr
    }

    // Record wallet transaction
    await supabase.from("wallet_transactions").insert({
      user_id: userId,
      order_id: order_id,
      amount: amount,
      type: "compensation",
      status: "completed",
      description: `استخدام رصيد تعويض في طلب`,
      currency: "SAR",
    })

    // Update order's wallet_used field
    await supabase
      .from("orders")
      .update({ wallet_used: amount })
      .eq("id", order_id)

    res.json({
      success: true,
      data: {
        used_amount: amount,
        compensations_used: updates.length,
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

/**
 * GET /api/wallet/:userId/withdrawals
 * سجل طلبات السحب للمستخدم
 */
router.get("/:userId/withdrawals", requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.userId)) return

  try {
    const { data, error } = await supabase
      .from("withdrawals")
      .select("*")
      .eq("user_id", req.params.userId)
      .order("requested_at", { ascending: false })
      .limit(50)

    if (error) throw error
    res.json({ success: true, data: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

/**
 * POST /api/wallet/:userId/withdraw
 * طلب سحب أرباح — Body: { amount }
 * الضوابط: محفظة قابلة للسحب، المبلغ >= الحد الأدنى، <= الرصيد المتاح، لا طلب معلق
 */
router.post("/:userId/withdraw", requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.userId)) return

  try {
    const { userId } = req.params
    const amt = parseFloat(req.body.amount)

    if (!isFinite(amt) || amt <= 0)
      return res.status(400).json({ success: false, message: "ادخل مبلغا صحيحا" })

    const wallet = await getOrCreateWallet(userId)
    if (!wallet.is_withdrawable)
      return res.status(403).json({ success: false, message: "هذه المحفظة غير قابلة للسحب" })

    // بلا آيبان يصل الطلب للإدارة ولا يمكن تنفيذه — نطلبه هنا لا عند التسجيل
    const { data: chefRow } = await supabase
      .from("chefs")
      .select("iban, bank_account_name")
      .eq("user_id", userId)
      .maybeSingle()

    if (chefRow && (!chefRow.iban || !chefRow.bank_account_name)) {
      return res.status(400).json({
        success: false,
        code: "BANK_REQUIRED",
        message: "أضف رقم الآيبان واسم صاحب الحساب أولاً حتى نحوّل أرباحك"
      })
    }

    const s = await getSettings()
    if (amt < Number(s.min_withdrawal_amount || 200))
      return res.status(400).json({ success: false, message: "الحد الأدنى للسحب " + Number(s.min_withdrawal_amount || 200) + " ريال" })

    if (amt > Number(wallet.available_balance || 0))
      return res.status(400).json({ success: false, message: "المبلغ أكبر من رصيدك المتاح (" + Number(wallet.available_balance || 0).toFixed(2) + " ريال)" })

    const { data: pendingRows } = await supabase
      .from("withdrawals")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "pending")
      .limit(1)

    if (pendingRows && pendingRows.length > 0)
      return res.status(409).json({ success: false, message: "لديك طلب سحب قيد المراجعة — انتظر معالجته أولا" })

    const { data, error } = await supabase
      .from("withdrawals")
      .insert({ user_id: userId, wallet_id: wallet.id, amount: amt, status: "pending" })
      .select()
      .single()

    if (error) throw error

    await notifyUser(
      userId,
      "تم استلام طلب السحب",
      "طلبك بمبلغ " + amt.toFixed(2) + " ريال قيد المراجعة وسنعلمك فور معالجته",
      "withdrawal_requested",
      { withdrawal_id: data.id }
    )

    res.status(201).json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

module.exports = router