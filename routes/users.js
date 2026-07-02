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
      await supabase.from('chefs').insert({
        user_id:      data.id,
        city:         req.body.city,
        neighborhood: req.body.neighborhood || ''
      })
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
      .from('users').select('*').eq('phone', phone).eq('is_active', true).single()
    if (error || !data)
      return res.status(404).json({ success: false, message: 'رقم الجوال غير مسجل' })
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
//  POST /users/send-notification — إرسال إشعار
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/send-notification', async (req, res) => {
  try {
    const { user_id, title, body, data } = req.body

    // جلب tokens المستخدم
    const { data: tokens, error } = await supabase
      .from('push_tokens').select('token').eq('user_id', user_id)
    if (error) throw error
    if (!tokens || tokens.length === 0)
      return res.json({ success: true, message: 'لا يوجد token' })

    // إرسال الإشعار عبر Expo
    const messages = tokens.map(t => ({
      to:    t.token,
      sound: 'default',
      title,
      body,
      data:  data || {},
    }))

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify(messages),
    })

    const result = await response.json()
    res.json({ success: true, result })
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
