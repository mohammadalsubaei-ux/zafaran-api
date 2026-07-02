const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/stats — إحصائيات اللوحة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/stats', async (req, res) => {
  try {
    const [orders, chefs, revenue] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact' }),
      supabase.from('chefs').select('id', { count: 'exact' }).eq('is_verified', true),
      supabase.from('orders').select('total').eq('status', 'delivered')
    ])

    const totalRevenue = revenue.data?.reduce((sum, o) => sum + o.total, 0) || 0
    const platformRevenue = revenue.data?.reduce((sum, o) => sum + (o.total * 0.17), 0) || 0

    res.json({
      success: true,
      data: {
        total_orders:      orders.count || 0,
        total_chefs:       chefs.count  || 0,
        total_revenue:     totalRevenue.toFixed(2),
        platform_revenue:  platformRevenue.toFixed(2)
      }
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/orders — كل الطلبات
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/orders', async (req, res) => {
  try {
    const { status, limit = 50 } = req.query

    let query = supabase
      .from('orders')
      .select(`*, users(full_name, phone), chefs(*, users(full_name))`)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/chefs/:id/verify — توثيق طباخة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/chefs/:id/verify', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chefs')
      .update({ is_verified: true })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router
