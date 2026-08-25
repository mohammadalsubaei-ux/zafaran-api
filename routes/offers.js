const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  العروض والخصومات
//
//  قاعدة مالية محسومة: العمولة تُحسب على المبلغ بعد الخصم دائمًا
//  (يجري تلقائيًا في routes/orders.js لأن subtotal يصله مخصومًا).
//  فلا يأخذ المنصة عمولة على ريال لم يُحصَّل، ولا يصير أحد مدينًا لأحد.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// هل العرض صالح للاستخدام الآن؟
function isUsable(o) {
  if (!o.is_active) return false
  if (new Date(o.starts_at) > new Date()) return false
  if (o.ends_at && new Date(o.ends_at) < new Date()) return false
  if (o.usage_limit != null && Number(o.usage_count) >= Number(o.usage_limit)) return false
  return true
}

// ━━ GET /offers?chef_id=... — عروض متجر (الكل لصاحبه، النشط للعميل) ━━
router.get('/', async (req, res) => {
  try {
    const { chef_id, all } = req.query

    if (!chef_id) {
      return res.status(400).json({ success: false, message: 'chef_id مطلوب' })
    }

    let query = supabase
      .from('offers')
      .select('*')
      .eq('chef_id', chef_id)
      .order('created_at', { ascending: false })

    if (!all) query = query.eq('is_active', true)

    const { data, error } = await query
    if (error) throw error

    const list = all ? (data || []) : (data || []).filter(isUsable)
    res.json({ success: true, data: list })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━ POST /offers — إنشاء عرض ━━
router.post('/', async (req, res) => {
  try {
    const {
      chef_id, menu_item_id, title,
      discount_type, discount_value,
      min_order_amount, max_discount_amount,
      starts_at, ends_at, usage_limit,
      created_by
    } = req.body

    if (!chef_id)  return res.status(400).json({ success: false, message: 'chef_id مطلوب' })
    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, message: 'عنوان العرض مطلوب' })
    }
    if (!['percent', 'fixed'].includes(discount_type)) {
      return res.status(400).json({ success: false, message: 'نوع الخصم يجب أن يكون percent أو fixed' })
    }

    const value = Number(discount_value)
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ success: false, message: 'قيمة الخصم غير صحيحة' })
    }
    if (discount_type === 'percent' && value >= 100) {
      return res.status(400).json({ success: false, message: 'نسبة الخصم يجب أن تكون أقل من 100' })
    }

    // المنتج — إن حُدِّد — يجب أن يتبع نفس المتجر
    if (menu_item_id) {
      const { data: item, error: itemErr } = await supabase
        .from('menu_items')
        .select('id, price, chef_id')
        .eq('id', menu_item_id)
        .single()

      if (itemErr || !item || item.chef_id !== chef_id) {
        return res.status(400).json({ success: false, message: 'المنتج غير موجود في متجرك' })
      }

      if (discount_type === 'fixed' && value >= Number(item.price)) {
        return res.status(400).json({ success: false, message: 'الخصم يجب أن يكون أقل من سعر المنتج' })
      }
    }

    const { data, error } = await supabase
      .from('offers')
      .insert({
        chef_id,
        menu_item_id: menu_item_id || null,
        title: String(title).trim(),
        discount_type,
        discount_value: value,
        min_order_amount: Number(min_order_amount) || 0,
        max_discount_amount: max_discount_amount != null ? Number(max_discount_amount) : null,
        starts_at: starts_at || new Date(),
        ends_at: ends_at || null,
        usage_limit: usage_limit != null ? Number(usage_limit) : null,
        created_by: created_by === 'admin' ? 'admin' : 'chef'
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━ PATCH /offers/:id — تفعيل أو إيقاف ━━
router.patch('/:id', async (req, res) => {
  try {
    const { is_active } = req.body

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ success: false, message: 'الحقل is_active مطلوب (true/false)' })
    }

    const { data, error } = await supabase
      .from('offers')
      .update({ is_active })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━ DELETE /offers/:id ━━
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('offers').delete().eq('id', req.params.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router