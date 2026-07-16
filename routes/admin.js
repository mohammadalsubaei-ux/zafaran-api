const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const supabase = require('../supabase')
const notifyUser = require('../notify')

const SESSION_DURATION_MS = 24 * 60 * 60 * 1000 // 24 ساعة

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex')
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Middleware — يحمي كل endpoints الأدمن (عدا تسجيل الدخول)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

    if (!token) {
      return res.status(401).json({ success: false, message: 'يلزم تسجيل الدخول' })
    }

    const { data: session, error } = await supabase
      .from('admin_sessions')
      .select('admin_id, expires_at')
      .eq('token', token)
      .single()

    if (error || !session) {
      return res.status(401).json({ success: false, message: 'جلسة غير صالحة، سجّل دخول مرة أخرى' })
    }

    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('admin_sessions').delete().eq('token', token)
      return res.status(401).json({ success: false, message: 'انتهت صلاحية الجلسة، سجّل دخول مرة أخرى' })
    }

    req.adminId = session.admin_id
    next()
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /admin/auth/login
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة السر مطلوبان' })
    }

    const { data: admin, error } = await supabase
      .from('admins')
      .select('id, username, password_hash, password_salt')
      .eq('username', username)
      .single()

    if (error || !admin) {
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' })
    }

    const computedHash = hashPassword(password, admin.password_salt)
    if (computedHash !== admin.password_hash) {
      return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' })
    }

    const token = generateToken()
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS)

    await supabase.from('admin_sessions').insert({
      token, admin_id: admin.id, expires_at: expiresAt.toISOString()
    })

    res.json({ success: true, data: { token, username: admin.username } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /admin/auth/logout
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/auth/logout', requireAdmin, async (req, res) => {
  try {
    const token = (req.headers.authorization || '').slice(7)
    await supabase.from('admin_sessions').delete().eq('token', token)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/auth/me — التحقق من صلاحية الجلسة الحالية
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/auth/me', requireAdmin, async (req, res) => {
  try {
    const { data: admin, error } = await supabase
      .from('admins')
      .select('id, username')
      .eq('id', req.adminId)
      .single()
    if (error) throw error
    res.json({ success: true, data: admin })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /admin/auth/change-password
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/auth/change-password', requireAdmin, async (req, res) => {
  try {
    const { current_password, new_password } = req.body

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'كل الحقول مطلوبة' })
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'كلمة السر الجديدة يجب أن تكون 8 أحرف على الأقل' })
    }

    const { data: admin, error } = await supabase
      .from('admins')
      .select('password_hash, password_salt')
      .eq('id', req.adminId)
      .single()

    if (error || !admin) throw error || new Error('لم يتم العثور على الحساب')

    const currentHash = hashPassword(current_password, admin.password_salt)
    if (currentHash !== admin.password_hash) {
      return res.status(401).json({ success: false, message: 'كلمة السر الحالية غير صحيحة' })
    }

    const newSalt = generateSalt()
    const newHash = hashPassword(new_password, newSalt)

    await supabase.from('admins').update({
      password_hash: newHash, password_salt: newSalt
    }).eq('id', req.adminId)

    res.json({ success: true, message: 'تم تغيير كلمة السر بنجاح' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/stats — إحصائيات اللوحة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const [orders, chefs, drivers, revenue] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact' }),
      supabase.from('chefs').select('id', { count: 'exact' }).eq('is_verified', true),
      supabase.from('drivers').select('id', { count: 'exact' }),
      supabase.from('orders').select('total, platform_fee').eq('status', 'delivered')
    ])

    const totalRevenue = revenue.data?.reduce((sum, o) => sum + Number(o.total || 0), 0) || 0
    // عمولة زعفران الحقيقية: مجموع platform_fee المخزون بدقة في كل طلب
    // (17% من الطلب + 10% من التوصيل مقربة للأعلى) — وليس 17% من الإجمالي الشامل للتوصيل
    const platformRevenue = revenue.data?.reduce((sum, o) => sum + Number(o.platform_fee || 0), 0) || 0

    res.json({
      success: true,
      data: {
        total_orders:      orders.count  || 0,
        total_chefs:       chefs.count   || 0,
        total_drivers:     drivers.count || 0,
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
router.get('/orders', requireAdmin, async (req, res) => {
  try {
    const { status, limit = 100 } = req.query

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
//  GET /admin/chefs — كل الشيفات
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/chefs', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chefs')
      .select('*, users(full_name, phone)')
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/chefs/:id/verify — توثيق شيف
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/chefs/:id/verify', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chefs')
      .update({ is_verified: true })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error

    if (data?.user_id) {
      await notifyUser(
        data.user_id,
        'تم توثيق حسابك',
        'مبروك! تم توثيق حسابك بزعفران، وطلباتك ووجباتك أصبحت ظاهرة للعملاء الآن.',
        'chef_verified',
        { chef_id: data.id }
      )
    }

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/drivers — كل المناديب
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/drivers', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('drivers')
      .select('*, users(full_name, phone)')
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/drivers/:id/verify — توثيق مندوب
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/drivers/:id/verify', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('drivers')
      .update({ is_verified: true })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error

    if (data?.user_id) {
      await notifyUser(
        data.user_id,
        'تم توثيق حسابك',
        'مبروك! تم توثيق حسابك كمندوب بزعفران، تقدر الحين تستقبل طلبات توصيل.',
        'driver_verified',
        { driver_id: data.id }
      )
    }

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router