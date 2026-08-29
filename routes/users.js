const express = require('express')
const { issueSession, revokeSession, requireUser, assertSelf, rateLimit } = require('../auth')
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
router.post('/register', rateLimit({ max: 6 }), async (req, res) => {
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
        // لا نترك مستخدما يتيما بدون ملف متجر — نحذفه ونرجع الخطأ الحقيقي
        await supabase.from('users').delete().eq('id', data.id)
        return res.status(500).json({ success: false, message: 'تعذر انشاء ملف المتجر: ' + chefErr.message })
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

    const token = await issueSession(data.id)
    res.status(201).json({ success: true, data: { ...data, token } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/login
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/login', rateLimit({ max: 8, message: 'محاولات دخول كثيرة — انتظر قليلاً' }), async (req, res) => {
  try {
    const { phone, password } = req.body
    if (!phone || !password)
      return res.status(400).json({ success: false, message: 'رقم الجوال وكلمة المرور مطلوبان' })

    const { data, error } = await supabase
      .from('users').select('*').eq('phone', phone).single()
    if (error || !data)
      return res.status(404).json({ success: false, message: 'رقم الجوال غير مسجل' })

    // الحساب المحذوف: رسالة صريحة تفرقه عن الموقوف إدارياً
    if (data.deleted_at)
      return res.status(403).json({ success: false, message: 'هذا الحساب محذوف — يمكنك إنشاء حساب جديد' })

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

    // رمز الجلسة — الهوية تُثبَت به لا بإرسال user_id في الجسم
    const token = await issueSession(data.id)

    res.json({ success: true, data: { ...data, token } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /users/:id — بيانات المستخدم (بدون أي حقول حساسة)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:id', requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.id)) return

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, phone, full_name, role, gender, avatar_url, is_active, created_at')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /users/:id/profile — تحديث الصورة الشخصية والاسم
//  body: { avatar_url?, full_name? }
//  الحقول المسموحة محصورة عمداً — الدور والحالة والجوال لا تُعدّل من التطبيق
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/profile', requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.id)) return

  try {
    const { avatar_url, full_name } = req.body
    const updates = {}

    if (avatar_url !== undefined) {
      // null يعني حذف الصورة — أي قيمة أخرى يجب أن تكون رابطاً آمناً
      if (avatar_url === null || avatar_url === '') {
        updates.avatar_url = null
      } else if (typeof avatar_url === 'string' && avatar_url.startsWith('https://')) {
        updates.avatar_url = avatar_url
      } else {
        return res.status(400).json({ success: false, message: 'رابط الصورة غير صالح' })
      }
    }

    if (full_name !== undefined) {
      const clean = String(full_name).trim()
      if (clean.length < 2) {
        return res.status(400).json({ success: false, message: 'الاسم قصير جداً' })
      }
      updates.full_name = clean
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'ما فيه أي حقل للتحديث' })
    }

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, phone, full_name, role, gender, avatar_url, is_active')
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /users/:id/deletion-check — فحص الموانع قبل عرض شاشة الحذف
//  يرجع أسباب المنع ليعرفها المستخدم مسبقاً بدل مفاجأته بالرفض
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ACTIVE_ORDER_STATUSES = ['pending', 'pending_time', 'accepted', 'preparing', 'ready', 'delivering']

router.get('/:id/deletion-check', requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.id)) return

  try {
    const userId = req.params.id
    const blockers = []

    const { data: user } = await supabase
      .from('users').select('id, role, deleted_at').eq('id', userId).single()

    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })
    if (user.deleted_at) return res.status(409).json({ success: false, message: 'الحساب محذوف مسبقاً' })

    // ١. طلبات جارية كعميل
    const { data: customerOrders } = await supabase
      .from('orders').select('id').eq('customer_id', userId).in('status', ACTIVE_ORDER_STATUSES)

    if (customerOrders && customerOrders.length > 0) {
      blockers.push({
        code: 'active_orders',
        message: 'عندك ' + customerOrders.length + ' طلب جاري — انتظر اكتماله أو ألغه قبل حذف الحساب'
      })
    }

    // ٢. طلبات جارية عند المتجر
    if (user.role === 'chef') {
      const { data: chef } = await supabase
        .from('chefs').select('id').eq('user_id', userId).maybeSingle()

      if (chef) {
        const { data: chefOrders } = await supabase
          .from('orders').select('id').eq('chef_id', chef.id).in('status', ACTIVE_ORDER_STATUSES)

        if (chefOrders && chefOrders.length > 0) {
          blockers.push({
            code: 'chef_active_orders',
            message: 'عند متجرك ' + chefOrders.length + ' طلب جاري — أكمله قبل حذف الحساب'
          })
        }
      }
    }

    // ٣. رصيد متبقٍ في المحفظة
    const { data: wallet } = await supabase
      .from('wallets').select('balance, available_balance, pending_balance')
      .eq('user_id', userId).maybeSingle()

    if (wallet) {
      const total = Number(wallet.balance || 0)
        + Number(wallet.available_balance || 0)
        + Number(wallet.pending_balance || 0)

      if (total > 0) {
        blockers.push({
          code: 'wallet_balance',
          message: 'عندك رصيد ' + total.toFixed(2) + ' ريال — اسحبه قبل حذف الحساب حتى لا تفقده'
        })
      }
    }

    // ٤. طلبات توصيل جارية كمندوب
    if (user.role === 'driver') {
      const { data: driverOrders } = await supabase
        .from('orders').select('id').eq('driver_id', userId).in('status', ACTIVE_ORDER_STATUSES)

      if (driverOrders && driverOrders.length > 0) {
        blockers.push({
          code: 'driver_active_orders',
          message: 'عندك ' + driverOrders.length + ' طلب توصيل جاري — سلّمه قبل حذف الحساب'
        })
      }
    }

    // ٥. طلبات سحب قيد المراجعة
    const { data: withdrawals } = await supabase
      .from('withdrawals').select('id').eq('user_id', userId).eq('status', 'pending')

    if (withdrawals && withdrawals.length > 0) {
      blockers.push({
        code: 'pending_withdrawal',
        message: 'عندك طلب سحب قيد المراجعة — انتظر تحويله قبل حذف الحساب'
      })
    }

    res.json({ success: true, data: { can_delete: blockers.length === 0, blockers } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/:id/delete — حذف الحساب (متطلب إلزامي لمتجر آبل)
//  body: { password }
//
//  حذف ناعم لا نهائي عمداً:
//  السجل المالي (الطلبات والقيود المحاسبية) يبقى سليماً لأنه التزام
//  محاسبي، بينما تُطمس البيانات الشخصية ويُقفل الدخول تماماً.
//  الجوال يُستبدل بقيمة فريدة حتى يبقى القيد الفريد سليماً ويستطيع
//  المستخدم التسجيل من جديد بنفس رقمه لو أراد.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/:id/delete', requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.id)) return

  try {
    const userId = req.params.id
    const { confirm_phone } = req.body

    const { data: user } = await supabase
      .from('users').select('*').eq('id', userId).single()

    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' })
    if (user.deleted_at) return res.status(409).json({ success: false, message: 'الحساب محذوف مسبقاً' })

    // الهوية مثبتة بالجلسة (requireUser + assertSelf). تأكيد الرقم خطوة
    // إضافية تمنع الحذف بالخطأ — لا كلمة مرور بعد التحوّل لرمز الجوال.
    const typed = String(confirm_phone || '').replace(/[^0-9]/g, '')
    const real  = String(user.phone || '').replace(/[^0-9]/g, '')

    if (!typed) {
      return res.status(400).json({ success: false, message: 'اكتب رقم جوالك لتأكيد الحذف' })
    }
    if (typed !== real) {
      return res.status(401).json({ success: false, message: 'رقم الجوال لا يطابق حسابك' })
    }

    // إعادة فحص الموانع خادمياً — لا نثق بفحص الواجهة وحده
    const { data: activeOrders } = await supabase
      .from('orders').select('id').eq('customer_id', userId).in('status', ACTIVE_ORDER_STATUSES)

    if (activeOrders && activeOrders.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'عندك طلبات جارية — انتظر اكتمالها أو ألغها قبل حذف الحساب'
      })
    }

    const { data: wallet } = await supabase
      .from('wallets').select('balance, available_balance, pending_balance')
      .eq('user_id', userId).maybeSingle()

    if (wallet) {
      const total = Number(wallet.balance || 0)
        + Number(wallet.available_balance || 0)
        + Number(wallet.pending_balance || 0)

      if (total > 0) {
        return res.status(409).json({
          success: false,
          message: 'عندك رصيد ' + total.toFixed(2) + ' ريال — اسحبه قبل حذف الحساب'
        })
      }
    }

    // عمود users.phone نوعه varchar(15) — 'deleted_' + Date.now() يعطي 21 حرفاً فيرفضه بوستجرس.
    // نستخدم DEL + آخر 12 رقماً من الطابع الزمني بالمللي ثانية = 15 حرفاً بالضبط، ويبقى فريداً.
    const stamp = String(Date.now()).slice(-12)

    // طمس البيانات الشخصية مع إبقاء الصف لسلامة المفاتيح الأجنبية
    const { error: userErr } = await supabase
      .from('users')
      .update({
        full_name:  'حساب محذوف',
        phone:      'DEL' + stamp,
        avatar_url: null,
        is_active:  false,
        deleted_at: new Date().toISOString(),
        password_hash: null,
        password_salt: null
      })
      .eq('id', userId)

    if (userErr) throw userErr

    // إخفاء المتجر من التطبيق فوراً
    if (user.role === 'chef') {
      await supabase.from('chefs')
        .update({ status: 'closed', is_open: false, is_verified: false })
        .eq('user_id', userId)
    }

    // إيقاف المندوب عن استقبال الطلبات
    if (user.role === 'driver') {
      await supabase.from('drivers')
        .update({ is_available: false, is_verified: false })
        .eq('user_id', userId)
    }

    // حذف رموز الإشعارات حتى لا تصله إشعارات بعد الحذف
    await supabase.from('push_tokens').delete().eq('user_id', userId)

    // حذف العناوين المحفوظة — بيانات شخصية بحتة بلا قيمة محاسبية
    await supabase.from('addresses').delete().eq('user_id', userId)

    res.json({ success: true, message: 'تم حذف حسابك' })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/push-token — حفظ token الإشعارات
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/push-token', requireUser, async (req, res) => {
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /users/:id/notifications
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:id/notifications', requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.id)) return

  try {
    const { data, error } = await supabase
      .from('notifications').select('*')
      .eq('user_id', req.params.id)
      .order('created_at', { ascending: false }).limit(30)
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/:id/change-password — تغيير المستخدم كلمته بنفسه
//  يتطلب الحالية للتحقق؛ الحسابات القديمة بلا كلمة تعينها مباشرة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/:id/change-password', rateLimit({ max: 6 }), requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.id)) return

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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/logout — إبطال رمز الجلسة الحالي
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/logout', requireUser, async (req, res) => {
  try {
    await revokeSession(req.sessionToken)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إنهاء الجلسة' })
  }
})


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /users/phone-auth — الدخول والتسجيل برمز الجوال
//
//  التطبيق يتحقق من الرقم عبر Firebase (هي التي ترسل الرمز)، ثم يرسل
//  لنا idToken. نتحقق منه عند Google — لا نثق بالرقم القادم من التطبيق.
//
//  نستخدم واجهة Identity Toolkit بمفتاح الويب بدل firebase-admin:
//  لا حساب خدمة ولا ملف مفاتيح على الخادم، ونتيجة التحقق واحدة.
//
//  body: { idToken, full_name?, role?, city? }
//   - حساب موجود  → جلسة مباشرة
//   - حساب جديد   → يلزم full_name (وrole للمتجر/المندوب)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/phone-auth', rateLimit({ max: 20 }), async (req, res) => {
  try {
    const { idToken, full_name, role = 'customer', city } = req.body

    if (!idToken) {
      return res.status(400).json({ success: false, message: 'رمز التحقق مطلوب' })
    }

    const apiKey = process.env.FIREBASE_WEB_API_KEY
    if (!apiKey) {
      return res.status(500).json({ success: false, message: 'التحقق بالجوال غير مهيأ على الخادم' })
    }

    // التحقق عند Google — الرقم يأتي من ردها لا من التطبيق
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    )

    const verifyJson = await verifyRes.json().catch(() => null)
    const fbUser = verifyJson?.users?.[0]

    if (!verifyRes.ok || !fbUser) {
      return res.status(401).json({ success: false, message: 'رمز التحقق غير صالح أو منتهي' })
    }

    if (!fbUser.phoneNumber) {
      return res.status(400).json({ success: false, message: 'لم نتعرف على رقم الجوال' })
    }

    // 966xxxxxxxxx → 05xxxxxxxx (الصيغة المخزّنة في قاعدتنا)
    let phone = String(fbUser.phoneNumber).replace(/[^0-9]/g, '')
    if (phone.startsWith('966')) phone = '0' + phone.slice(3)
    if (!phone.startsWith('0')) phone = '0' + phone

    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .maybeSingle()

    // ── حساب موجود ──
    if (existing) {
      if (existing.deleted_at) {
        return res.status(403).json({ success: false, message: 'هذا الحساب محذوف' })
      }

      delete existing.password_hash
      delete existing.password_salt

      const token = await issueSession(existing.id)
      return res.json({ success: true, data: { ...existing, token }, is_new: false })
    }

    // ── حساب جديد ──
    const name = String(full_name || '').trim()
    if (!name) {
      // التطبيق يعرض شاشة الاسم ثم يعيد الطلب بنفس الرمز
      return res.status(200).json({ success: true, needs_profile: true, phone })
    }

    const { data: created, error: createErr } = await supabase
      .from('users')
      .insert({ phone, full_name: name, role })
      .select()
      .single()

    if (createErr) throw createErr

    if (role === 'chef') {
      const { error: chefErr } = await supabase
        .from('chefs')
        .insert({ user_id: created.id, city: city || null, status: 'closed', is_verified: false })

      if (chefErr) {
        await supabase.from('users').delete().eq('id', created.id)
        return res.status(500).json({ success: false, message: 'تعذر إنشاء ملف المتجر' })
      }
    }

    if (role === 'driver') {
      const { error: drvErr } = await supabase
        .from('drivers')
        .insert({ user_id: created.id, is_available: false, is_verified: false })

      if (drvErr) {
        await supabase.from('users').delete().eq('id', created.id)
        return res.status(500).json({ success: false, message: 'تعذر إنشاء ملف المندوب' })
      }
    }

    delete created.password_hash
    delete created.password_salt

    const token = await issueSession(created.id)
    res.status(201).json({ success: true, data: { ...created, token }, is_new: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام التحقق — حاول مرة ثانية' })
  }
})

module.exports = router