const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /chefs/search?q= — بحث
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query
    if (!q) return res.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('menu_items')
      .select(`*, chefs (*, users ( full_name, avatar_url, phone ))`)
      .ilike('name', `%${q}%`)
      .neq('status', 'unavailable')

    if (error) throw error

    const chefsMap = new Map()
    data.forEach(item => {
      if (item.chefs && item.chefs.status !== 'closed' && !chefsMap.has(item.chefs.id)) {
        chefsMap.set(item.chefs.id, item.chefs)
      }
    })

    res.json({ success: true, data: Array.from(chefsMap.values()) })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /chefs — كل الطباخات المتاحة
//  status: open | preorder | closed
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/', async (req, res) => {
  try {
    const { city, status, user_id } = req.query

    let query = supabase
      .from('chefs')
      .select(`*, users ( full_name, avatar_url, phone )`)

    if (!user_id) query = query.eq('is_verified', true)
    if (city)    query = query.eq('city', city)
    if (user_id) query = query.eq('user_id', user_id)

    if (status) {
      // فلترة صريحة لحالة معينة (open أو preorder أو closed)
      query = query.eq('status', status)
    } else if (!user_id) {
      // افتراضياً للعميل: نخفي الشيفات المغلقة تماماً
      query = query.neq('status', 'closed')
    }

    const { data, error } = await query.order('rating_avg', { ascending: false })

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /chefs/:id — طباخة معينة + قائمتها
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:id', async (req, res) => {
  try {
    const { data: chef, error: chefErr } = await supabase
      .from('chefs')
      .select(`*, users ( full_name, avatar_url )`)
      .eq('id', req.params.id)
      .single()

    if (chefErr) throw chefErr

    const { data: menu, error: menuErr } = await supabase
      .from('menu_items')
      .select('*')
      .eq('chef_id', req.params.id)
      .neq('status', 'unavailable')
      .order('category')

    if (menuErr) throw menuErr

    res.json({ success: true, data: { ...chef, menu } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /chefs/:id/toggle — تحديث حالة الطباخة
//  body: { status: 'open' | 'preorder' | 'closed' }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { status } = req.body

    if (!['open', 'preorder', 'closed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status غير صالحة. القيم المسموحة: open, preorder, closed' })
    }

    const { data, error } = await supabase
      .from('chefs')
      .update({ status, is_open: status === 'open' }) // نحافظ على is_open متزامن لأي كود قديم يعتمد عليه
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error

    // عند التحويل لـ"حجز مسبق": كل الوجبات المتاحة تتحول تلقائياً لحجز مسبق أيضاً
    // (الوجبات اللي أصلاً "حجز مسبق" أو "غير متاحة" ما تتأثر — ما فيه تراجع تلقائي عكسي)
    if (status === 'preorder') {
      await supabase
        .from('menu_items')
        .update({ status: 'preorder', is_available: false })
        .eq('chef_id', req.params.id)
        .eq('status', 'available')
    }

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router