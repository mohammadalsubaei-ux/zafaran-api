const express = require('express')
const router  = express.Router()
const supabase = require('../supabase')
const crypto = require('crypto')

// نفس تقنية تشفير الأدمن — scrypt بملح عشوائي لكل مستخدم
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}
function generateSalt() {
  return crypto.randomBytes(16).toString('hex')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/register
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/register', async (req, res) => {
  try {
    const { phone, full_name, role = 'customer', password } = req.body
    if (!phone || !full_name)
      return res.status(400).json({ success: false, message: 'رقم الجوال والاسم مطلوبان' })
    if (!password || String(password).length < 6)
      return res.status(400).json({ success: false, message: 'كلمة المرور مطلوبة (6 احرف على الاقل)' })

    const { data: existing } = await supabase
      .from('users').select('id').eq('phone', phone).single()
    if (existing)
      return res.status(400).json({ success: false, message: 'رقم الجوال مسجل مسبقاً' })

    const password_salt = generateSalt()
    const password_hash = hashPassword(String(password), password_salt)

    const { data, error } = await supabase
      .from('users').insert({ phone, full_name, role, password_hash, password_salt }).select().single()
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

    // لا نعيد التجزئة والملح للتطبيق ابدا
    delete data.password_hash
    delete data.password_salt
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
    const { phone, password } = req.body
    if (!phone || !password)
      return res.status(400).json({ success: false, message: 'رقم الجوال وكلمة المرور مطلوبان' })

    const { data, error } = await supabase
      .from('users').select('*').eq('phone', phone).single()
    if (error || !data)
      return res.status(404).json({ success: false, message: 'رقم الجوال غير مسجل' })

    // الحساب الموقوف من الإدارة: رسالة صريحة بدل "غير مسجل" المضللة
    if (data.is_active === false)
      return res.status(403).json({ success: false, message: 'حسابك موقوف — للاستفسار تواصل مع دعم زعفران' })

    // حسابات ما قبل نظام كلمة المرور: تعيينها يتم من لوحة الأدمن
    if (!data.password_hash || !data.password_salt)
      return res.status(409).json({ success: false, message: 'حسابك يحتاج تعيين كلمة مرور — تواصل مع دعم زعفران' })

    if (hashPassword(String(password), data.password_salt) !== data.password_hash)
      return res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة' })

    delete data.password_hash
    delete data.password_salt
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/:id/change-password — تغيير المستخدم كلمته بنفسه
//  يتطلب الحالية للتحقق؛ الحسابات القديمة بلا كلمة تعينها مباشرة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/:id/change-password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body

    if (!new_password || String(new_password).length < 6)
      return res.status(400).json({ success: false, message: 'كلمة المرور الجديدة 6 احرف على الاقل' })

    const { data: user } = await supabase
      .from('users')
      .select('id, password_hash, password_salt')
      .eq('id', req.params.id)
      .single()

    if (!user)
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })

    if (user.password_hash && user.password_salt) {
      if (!current_password)
        return res.status(400).json({ success: false, message: 'ادخل كلمة المرور الحالية' })
      if (hashPassword(String(current_password), user.password_salt) !== user.password_hash)
        return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' })
    }

    const password_salt = generateSalt()
    const password_hash = hashPassword(String(new_password), password_salt)

    const { error } = await supabase
      .from('users')
      .update({ password_hash, password_salt })
      .eq('id', user.id)

    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router