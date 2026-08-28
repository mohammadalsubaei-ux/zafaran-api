const express  = require('express')
const { requireUser, assertSelf } = require('../auth')
const router   = express.Router()
const supabase = require('../supabase')

// ━━━ GET /addresses/:user_id — جلب عناوين المستخدم ━━━
router.get('/:user_id', requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.user_id)) return

  try {
    const { data, error } = await supabase
      .from('addresses')
      .select('*')
      .eq('user_id', req.params.user_id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━ POST /addresses — إضافة عنوان جديد ━━━
router.post('/', requireUser, async (req, res) => {
  try {
    // العنوان يُنشأ لصاحب الجلسة فقط — أياً كان user_id المرسل
    req.body.user_id = req.userId

    const { user_id, label, address, lat, lng, is_default } = req.body
    if (!user_id || !address)
      return res.status(400).json({ success: false, message: 'user_id والعنوان مطلوبان' })

    // إذا هو الافتراضي — نلغي الافتراضي القديم
    if (is_default) {
      await supabase.from('addresses')
        .update({ is_default: false })
        .eq('user_id', user_id)
    }

    const { data, error } = await supabase
      .from('addresses')
      .insert({ user_id, label: label || 'منزل', address, lat, lng, is_default: is_default || false })
      .select().single()
    if (error) throw error
    res.status(201).json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━ PATCH /addresses/:id — تعديل عنوان ━━━
router.patch('/:id', requireUser, async (req, res) => {
  try {
    const { label, address, lat, lng, is_default } = req.body

    if (is_default) {
      await supabase.from('addresses')
        .update({ is_default: false })
        .eq('user_id', req.userId)
    }

    // الشرط المزدوج يمنع تعديل عنوان شخص آخر حتى لو عُرف معرّفه
    const { data, error } = await supabase
      .from('addresses')
      .update({ label, address, lat, lng, is_default })
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .select().single()
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━ DELETE /addresses/:id — حذف عنوان ━━━
router.delete('/:id', requireUser, async (req, res) => {
  try {
    const { error } = await supabase
      .from('addresses')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

module.exports = router
