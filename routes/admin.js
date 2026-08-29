const express = require('express')
const { canBuyPlan, planStatus } = require('../plans')
const { rateLimit } = require('../auth')
const router = express.Router()
const crypto = require('crypto')
const supabase = require('../supabase')
const notifyUser = require('../notify')
const { STATUS_AR, TERMINAL_STATUSES, ADMIN_TRANSITIONS, getOrderCore, applyStatusChange } = require('../orderStatus')

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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /admin/auth/login
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/auth/login', rateLimit({ max: 6, message: 'محاولات دخول كثيرة — انتظر قليلاً' }), async (req, res) => {
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/settings — كل إعدادات المنصة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('*')
      .order('key')

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/settings — تعديل قيمة إعداد
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/settings', requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body
    if (!key) {
      return res.status(400).json({ success: false, message: 'المفتاح مطلوب' })
    }

    const num = parseFloat(value)
    if (!isFinite(num) || num < 0) {
      return res.status(400).json({ success: false, message: 'القيمة يجب ان تكون رقما موجبا' })
    }
    if (key.endsWith('_rate') && num > 1) {
      return res.status(400).json({ success: false, message: 'النسبة يجب ان تكون بين 0 و 1' })
    }

    const { data, error } = await supabase
      .from('app_settings')
      .update({ value: String(num), updated_at: new Date().toISOString() })
      .eq('key', key)
      .select()
      .single()

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'الاعداد غير موجود' })
    }
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/orders/:id — تفاصيل الطلب الكاملة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, users(full_name, phone), chefs(id, city, user_id, users(full_name, phone)), drivers(id, user_id, users(full_name, phone)), order_items(*)')
      .eq('id', req.params.id)
      .single()

    if (error || !data) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' })
    }
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/orders/:id/status — تغيير حالة/إلغاء بضوابط تسلسل الحالات
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, cancel_reason } = req.body

    const adminUsable = ['accepted', 'preparing', 'ready', 'delivering', 'delivered', 'cancelled']
    if (!adminUsable.includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صحيحة' })
    }

    const order = await getOrderCore(req.params.id)
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' })
    }

    if (TERMINAL_STATUSES.includes(order.status)) {
      return res.status(409).json({ success: false, message: 'الطلب بحالة نهائية (' + STATUS_AR[order.status] + ') ولا يمكن تعديله' })
    }

    const allowed = ADMIN_TRANSITIONS[order.status] || []
    if (!allowed.includes(status)) {
      return res.status(409).json({ success: false, message: 'لا يمكن الانتقال من "' + STATUS_AR[order.status] + '" إلى "' + STATUS_AR[status] + '"' })
    }

    if (status === 'cancelled' && (!cancel_reason || !cancel_reason.trim())) {
      return res.status(400).json({ success: false, message: 'سبب الإلغاء مطلوب — سيصل العميل في الإشعار' })
    }

    const updated = await applyStatusChange(order, status, {
      cancel_reason: cancel_reason ? cancel_reason.trim() : undefined,
      cancelled_by: 'admin',
      notifyChef: status === 'cancelled'
    })
    res.json({ success: true, data: updated })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/users — بحث وقائمة المستخدمين
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { role = '' } = req.query
    const search = String(req.query.search || '').replace(/[,()]/g, '').trim()

    let query = supabase
      .from('users')
      .select('id, full_name, phone, role, is_active, created_at')
      .order('created_at', { ascending: false })
      .limit(200)

    if (role) query = query.eq('role', role)
    if (search) query = query.or('full_name.ilike.%' + search + '%,phone.ilike.%' + search + '%')

    const { data, error } = await query
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /admin/users — إضافة مستخدم يدوياً
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { full_name, phone, role = 'customer', city, neighborhood } = req.body

    if (!full_name || !phone)
      return res.status(400).json({ success: false, message: 'الاسم ورقم الجوال مطلوبان' })
    if (!['customer', 'chef', 'driver'].includes(role))
      return res.status(400).json({ success: false, message: 'دور غير صحيح' })
    if (role === 'chef' && !city)
      return res.status(400).json({ success: false, message: 'مدينة الشيف مطلوبة' })

    const { data: existing } = await supabase
      .from('users').select('id').eq('phone', phone).limit(1)
    if (existing && existing.length > 0)
      return res.status(409).json({ success: false, message: 'رقم الجوال مسجل مسبقاً' })

    const { data, error } = await supabase
      .from('users').insert({ phone, full_name, role }).select().single()
    if (error) throw error

    if (role === 'chef') {
      const { error: chefErr } = await supabase.from('chefs').insert({
        user_id: data.id, city, neighborhood: neighborhood || ''
      })
      if (chefErr) {
        await supabase.from('users').delete().eq('id', data.id)
        return res.status(500).json({ success: false, message: 'تعذر انشاء ملف الشيف: ' + chefErr.message })
      }
    }

    if (role === 'driver') {
      const { error: driverErr } = await supabase.from('drivers').insert({
        user_id: data.id, is_verified: false, is_available: false,
        total_deliveries: 0, total_earnings: 0
      })
      if (driverErr) {
        await supabase.from('users').delete().eq('id', data.id)
        return res.status(500).json({ success: false, message: 'تعذر انشاء ملف المندوب: ' + driverErr.message })
      }
    }

    res.status(201).json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/users/:id — تفاصيل المستخدم وملفه حسب دوره
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('*').eq('id', req.params.id).single()
    if (!user)
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })

    let profile = null
    if (user.role === 'chef') {
      const { data: rows } = await supabase
        .from('chefs')
        .select('id, city, neighborhood, is_verified, is_open, rating_avg, total_orders, total_earnings, commission_rate')
        .eq('user_id', user.id).limit(1)
      profile = rows && rows[0] ? rows[0] : null
    }
    if (user.role === 'driver') {
      const { data: rows } = await supabase
        .from('drivers')
        .select('id, is_verified, is_available, total_deliveries, total_earnings')
        .eq('user_id', user.id).limit(1)
      profile = rows && rows[0] ? rows[0] : null
    }

    res.json({ success: true, data: { user, profile } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/users/:id — تعديل الاسم أو الجوال
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { full_name, phone } = req.body
    const updates = {}
    if (full_name && full_name.trim()) updates.full_name = full_name.trim()
    if (phone && phone.trim()) updates.phone = phone.trim()

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ success: false, message: 'لا يوجد ما يُعدَّل' })

    if (updates.phone) {
      const { data: taken } = await supabase
        .from('users').select('id').eq('phone', updates.phone).neq('id', req.params.id).limit(1)
      if (taken && taken.length > 0)
        return res.status(409).json({ success: false, message: 'رقم الجوال مستخدم لحساب اخر' })
    }

    const { data, error } = await supabase
      .from('users').update(updates).eq('id', req.params.id).select().single()
    if (error || !data)
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/users/:id/active — إيقاف/تفعيل الحساب
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/users/:id/active', requireAdmin, async (req, res) => {
  try {
    const { is_active } = req.body
    if (typeof is_active !== 'boolean')
      return res.status(400).json({ success: false, message: 'is_active يجب ان تكون true او false' })

    const { data, error } = await supabase
      .from('users').update({ is_active }).eq('id', req.params.id).select().single()
    if (error || !data)
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DELETE /admin/users/:id — حذف بضوابط
//  المرتبط بأي طلبات (كعميل/شيف/مندوب) لا يُحذف — يُوقَف بدلاً من ذلك
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id

    const { data: user } = await supabase
      .from('users').select('id, role').eq('id', id).single()
    if (!user)
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })

    // ملفات الأدوار
    const { data: chefRows } = await supabase
      .from('chefs').select('id').eq('user_id', id).limit(1)
    const chefRow = chefRows && chefRows[0] ? chefRows[0] : null

    const { data: driverRows } = await supabase
      .from('drivers').select('id').eq('user_id', id).limit(1)
    const driverRow = driverRows && driverRows[0] ? driverRows[0] : null

    // الضوابط: أي ارتباط بطلبات يمنع الحذف
    const { count: asCustomer } = await supabase
      .from('orders').select('id', { count: 'exact', head: true }).eq('customer_id', id)

    let asChef = 0
    if (chefRow) {
      const { count } = await supabase
        .from('orders').select('id', { count: 'exact', head: true }).eq('chef_id', chefRow.id)
      asChef = count || 0
    }

    let asDriver = 0
    if (driverRow) {
      const { count } = await supabase
        .from('orders').select('id', { count: 'exact', head: true }).eq('driver_id', driverRow.id)
      asDriver = count || 0
    }

    const involvement = (asCustomer || 0) + asChef + asDriver
    if (involvement > 0) {
      return res.status(409).json({
        success: false,
        message: 'المستخدم مرتبط بـ ' + involvement + ' طلب — لحماية السجلات المالية أوقف حسابه بدلا من حذفه'
      })
    }

    // حذف متسلسل للسجلات التابعة ثم المستخدم
    await supabase.from('notifications').delete().eq('user_id', id)
    await supabase.from('push_tokens').delete().eq('user_id', id)
    await supabase.from('addresses').delete().eq('user_id', id)
    await supabase.from('wallets').delete().eq('user_id', id)

    if (chefRow) {
      await supabase.from('menu_items').delete().eq('chef_id', chefRow.id)
      await supabase.from('chefs').delete().eq('id', chefRow.id)
    }
    if (driverRow) {
      await supabase.from('drivers').delete().eq('id', driverRow.id)
    }

    const { error: delErr } = await supabase.from('users').delete().eq('id', id)
    if (delErr)
      return res.status(500).json({ success: false, message: 'تعذر الحذف: ' + delErr.message })

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/banners — كل البانرات (مفعلة وموقفة)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/banners', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('banners')
      .select('*')
      .order('sort_order', { ascending: true })

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /admin/banners — إضافة بانر
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/banners', requireAdmin, async (req, res) => {
  try {
    const { title, subtitle, bg_color, text_color, target, sort_order } = req.body
    if (!title || !title.trim())
      return res.status(400).json({ success: false, message: 'عنوان البانر مطلوب' })

    const { data, error } = await supabase
      .from('banners')
      .insert({
        title: title.trim(),
        subtitle: subtitle ? subtitle.trim() : null,
        bg_color: bg_color || '#3E2410',
        text_color: text_color || '#FDF0DC',
        target: target || null,
        sort_order: Number.isFinite(parseInt(sort_order)) ? parseInt(sort_order) : 0
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/banners/:id — تعديل بانر (نصوص/ألوان/تفعيل/ترتيب)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/banners/:id', requireAdmin, async (req, res) => {
  try {
    const { title, subtitle, bg_color, text_color, target, sort_order, is_active } = req.body
    const updates = {}
    if (title !== undefined) {
      if (!title || !title.trim())
        return res.status(400).json({ success: false, message: 'عنوان البانر مطلوب' })
      updates.title = title.trim()
    }
    if (subtitle !== undefined)   updates.subtitle   = subtitle ? subtitle.trim() : null
    if (bg_color !== undefined)   updates.bg_color   = bg_color || '#3E2410'
    if (text_color !== undefined) updates.text_color = text_color || '#FDF0DC'
    if (target !== undefined)     updates.target     = target || null
    if (sort_order !== undefined && Number.isFinite(parseInt(sort_order))) updates.sort_order = parseInt(sort_order)
    if (typeof is_active === 'boolean') updates.is_active = is_active

    if (Object.keys(updates).length === 0)
      return res.status(400).json({ success: false, message: 'لا يوجد ما يعدل' })

    const { data, error } = await supabase
      .from('banners')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error || !data)
      return res.status(404).json({ success: false, message: 'البانر غير موجود' })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DELETE /admin/banners/:id — حذف بانر
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.delete('/banners/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('banners')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/users/:id/password — تعيين كلمة مرور للمستخدم
//  (مسار الدعم: حسابات قديمة او "نسيت كلمة المرور" حتى يتوفر OTP)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/users/:id/password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body
    if (!password || String(password).length < 6)
      return res.status(400).json({ success: false, message: 'كلمة المرور 6 احرف على الاقل' })

    const password_salt = generateSalt()
    const password_hash = hashPassword(String(password), password_salt)

    const { data, error } = await supabase
      .from('users')
      .update({ password_hash, password_salt })
      .eq('id', req.params.id)
      .select('id')
      .single()

    if (error || !data)
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/withdrawals — طلبات السحب مع بيانات أصحابها
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/withdrawals', requireAdmin, async (req, res) => {
  try {
    const { status = '' } = req.query
    let query = supabase
      .from('withdrawals')
      .select('*')
      .order('requested_at', { ascending: false })
      .limit(200)
    if (status) query = query.eq('status', status)

    const { data: rows, error } = await query
    if (error) throw error

    const userIds = [...new Set((rows || []).map(r => r.user_id))]
    let usersMap = {}
    if (userIds.length > 0) {
      const { data: usersRows } = await supabase
        .from('users')
        .select('id, full_name, phone')
        .in('id', userIds)
      for (const u of usersRows || []) usersMap[u.id] = u
    }

    // بيانات التحويل — بدونها توافق على السحب ولا تعرف إلى أين تحوّل
    let bankMap = {}
    if (userIds.length > 0) {
      const { data: chefRows } = await supabase
        .from('chefs')
        .select('user_id, iban, bank_account_name')
        .in('user_id', userIds)

      for (const ch of chefRows || []) {
        bankMap[ch.user_id] = { iban: ch.iban || null, bank_account_name: ch.bank_account_name || null }
      }
    }

    const data = (rows || []).map(r => ({
      ...r,
      user: usersMap[r.user_id] || null,
      bank: bankMap[r.user_id] || null
    }))
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/withdrawals/:id — موافقة (خصم + توثيق تحويل) أو رفض بسبب
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/withdrawals/:id', requireAdmin, async (req, res) => {
  try {
    const { action, reason } = req.body
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ success: false, message: 'action يجب ان تكون approve او reject' })

    const { data: w } = await supabase
      .from('withdrawals')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (!w)
      return res.status(404).json({ success: false, message: 'طلب السحب غير موجود' })
    if (w.status !== 'pending')
      return res.status(409).json({ success: false, message: 'الطلب معالج مسبقا (' + w.status + ')' })

    if (action === 'reject') {
      if (!reason || !reason.trim())
        return res.status(400).json({ success: false, message: 'سبب الرفض مطلوب — سيصل صاحب الطلب' })

      await supabase
        .from('withdrawals')
        .update({ status: 'rejected', reject_reason: reason.trim(), processed_at: new Date().toISOString() })
        .eq('id', w.id)

      await notifyUser(
        w.user_id,
        'تم رفض طلب السحب',
        'طلبك بمبلغ ' + Number(w.amount).toFixed(2) + ' ريال رفض — السبب: ' + reason.trim(),
        'withdrawal_rejected',
        { withdrawal_id: w.id }
      )
      return res.json({ success: true })
    }

    // الموافقة: تحقق الرصيد ثم الخصم وتوثيق الحركة
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id, balance, available_balance')
      .eq('user_id', w.user_id)
      .maybeSingle()

    const available = Number(wallet?.available_balance || 0)
    if (!wallet || available < Number(w.amount))
      return res.status(409).json({ success: false, message: 'رصيد الشيف المتاح (' + available.toFixed(2) + ') أقل من مبلغ الطلب' })

    const { error: walletErr } = await supabase
      .from('wallets')
      .update({
        available_balance: available - Number(w.amount),
        balance: Number(wallet.balance || 0) - Number(w.amount)
      })
      .eq('id', wallet.id)
    if (walletErr) throw walletErr

    const { error: txErr } = await supabase.from('wallet_transactions').insert({
      user_id: w.user_id,
      amount: Number(w.amount),
      type: 'withdrawal',
      status: 'completed',
      description: 'سحب أرباح — تم التحويل',
      currency: 'SAR'
    })
    if (txErr) {
      // فشل القيد بعد الخصم: نرجع الرصيد كما كان كي لا تختل المحفظة
      await supabase
        .from('wallets')
        .update({ available_balance: available, balance: Number(wallet.balance || 0) })
        .eq('id', wallet.id)
      throw txErr
    }

    await supabase
      .from('withdrawals')
      .update({ status: 'approved', processed_at: new Date().toISOString() })
      .eq('id', w.id)

    await notifyUser(
      w.user_id,
      'تم تحويل أرباحك',
      'تم تحويل ' + Number(w.amount).toFixed(2) + ' ريال إلى حسابك — بالتوفيق!',
      'withdrawal_approved',
      { withdrawal_id: w.id }
    )

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /admin/plans — الباقات مع حالتها
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/plans', requireAdmin, async (req, res) => {
  try {
    const { data: plans, error } = await supabase
      .from('store_plans')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) throw error

    const chefIds = [...new Set((plans || []).map(p => p.chef_id))]
    let chefMap = {}

    if (chefIds.length > 0) {
      const { data: chefs } = await supabase
        .from('chefs')
        .select('id, rating_avg, total_orders, users(full_name, phone)')
        .in('id', chefIds)

      for (const ch of chefs || []) chefMap[ch.id] = ch
    }

    const data = (plans || []).map(p => ({
      ...p,
      chef: chefMap[p.chef_id] || null,
      status: planStatus(p, chefMap[p.chef_id])
    }))

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /admin/plans — تفعيل باقة يدوياً بعد التحويل عبر واتساب
//  body: { chef_id, plan_type, impressions_total, commission_rate?, ends_at? }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/plans', requireAdmin, async (req, res) => {
  try {
    const { chef_id, plan_type, impressions_total, commission_rate, ends_at } = req.body

    if (!chef_id) return res.status(400).json({ success: false, message: 'chef_id مطلوب' })
    if (!['featured', 'premium'].includes(plan_type)) {
      return res.status(400).json({ success: false, message: 'نوع الباقة يجب أن يكون featured أو premium' })
    }

    const impressions = Number(impressions_total)
    if (!Number.isFinite(impressions) || impressions <= 0) {
      return res.status(400).json({ success: false, message: 'عدد الظهورات غير صحيح' })
    }

    const { data: chef } = await supabase
      .from('chefs')
      .select('id, rating_avg, total_orders')
      .eq('id', chef_id)
      .maybeSingle()

    if (!chef) return res.status(404).json({ success: false, message: 'المتجر غير موجود' })

    // لا تُباع لمتجر لم يثبت نفسه — يحمي العميل ويحمي المتجر من إحراق ميزانيته
    const check = canBuyPlan(chef)
    if (!check.allowed) {
      return res.status(409).json({ success: false, message: check.reason })
    }

    const { data, error } = await supabase
      .from('store_plans')
      .insert({
        chef_id,
        plan_type,
        impressions_total: impressions,
        commission_rate: commission_rate != null ? Number(commission_rate) : null,
        ends_at: ends_at || null
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /admin/plans/:id — تعليق أو إنهاء
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/plans/:id', requireAdmin, async (req, res) => {
  try {
    const { is_suspended, is_active, suspended_reason } = req.body
    const updates = {}

    if (typeof is_suspended === 'boolean') {
      updates.is_suspended = is_suspended
      updates.suspended_reason = is_suspended ? (suspended_reason || 'معلّقة من الإدارة') : null
    }
    if (typeof is_active === 'boolean') updates.is_active = is_active

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'لا يوجد تغيير' })
    }

    const { data, error } = await supabase
      .from('store_plans')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

module.exports = router