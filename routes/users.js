const express = require('express')
const router  = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/register
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/register', async (req, res) => {
  try {
    const { phone, full_name, role = 'customer' } = req.body
    if (!phone || !full_name)
      return res.status(400).json({ success: false, message: 'رقم الجوال والاسم مطلوبان' })

    const { data: existing } = await supabase
      .from('users').select('id').eq('phone', phone).single()
    if (existing)
      return res.status(400).json({ success: false, message: 'رقم الجوال مسجل مسبقاً' })

    const { data, error } = await supabase
      .from('users').insert({ phone, full_name, role }).select().single()
    if (error) throw error

    if (role === 'chef' && req.body.city) {
      const { error: chefErr } = await supabase.from('chefs').insert({
        user_id:      data.id,
        city:         req.body.city,
        neighborhood: req.body.neighborhood || ''
      })
      if (chefErr) {
        // لا نترك مستخدما يتيما بدون ملف شيف — نحذفه ونرجع الخطأ الحقيقي
        await supabase.from('users').delete().eq('id', data.id)
        return res.status(500).json({ success: false, message: 'تعذر انشاء ملف الشيف: ' + chefErr.message })
      }
    }

    // مندوب جديد: إنشاء سجله بجدول drivers فوراً
    // (بدونه لوحة المندوب لا تجد ملفه وتفشل) — يبدأ غير موثّق
    // وغير متاح حتى يوثّقه الأدمن ويفعّل حالته بنفسه
    if (role === 'driver') {
      const { error: driverErr } = await supabase.from('drivers').insert({
        user_id:          data.id,
        is_verified:      false,
        is_available:     false,
        total_deliveries: 0,
        total_earnings:   0
      })
      if (driverErr) {
        // لا نترك مستخدما يتيما بدون ملف مندوب — نحذفه ونرجع الخطأ الحقيقي
        await supabase.from('users').delete().eq('id', data.id)
        return res.status(500).json({ success: false, message: 'تعذر انشاء ملف المندوب: ' + driverErr.message })
      }
    }

    res.status(201).json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/login
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/login', async (req, res) => {
  try {
    const { phone } = req.body
    const { data, error } = await supabase
      .from('users').select('*').eq('phone', phone).single()
    if (error || !data)
      return res.status(404).json({ success: false, message: 'رقم الجوال غير مسجل' })

    // الحساب الموقوف من الإدارة: رسالة صريحة بدل "غير مسجل" المضللة
    if (data.is_active === false)
      return res.status(403).json({ success: false, message: 'حسابك موقوف — للاستفسار تواصل مع دعم زعفران' })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/push-token — حفظ token الإشعارات
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/push-token', async (req, res) => {
  try {
    const { user_id, token, platform } = req.body
    if (!user_id || !token)
      return res.status(400).json({ success: false, message: 'user_id و token مطلوبان' })

    const { error } = await supabase
      .from('push_tokens')
      .upsert({ user_id, token, platform }, { onConflict: 'user_id,token' })

    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /users/:id/notifications
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:id/notifications', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications').select('*')
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false }).limit(30)
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router