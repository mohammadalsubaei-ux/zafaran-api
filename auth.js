// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  زعفران — طبقة المصادقة والتحقق من الملكية
//
//  المبدأ: الهوية تأتي من رمز الجلسة، لا من الرابط ولا من جسم الطلب.
//  إرسال user_id في الجسم لا يثبت شيئاً — أي أحد يرسل معرّف غيره.
//
//  الاستخدام:
//    const { requireUser, assertSelf, chefOfUser, assertChefOwner } = require('../auth')
//    router.patch('/:id/profile', requireUser, async (req, res) => {
//      if (!assertSelf(req, res, req.params.id)) return
//      ...
//    })
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const crypto = require('crypto')
const supabase = require('./supabase')

const SESSION_DAYS = 60

function newToken() {
  return crypto.randomBytes(32).toString('hex')
}

// يُستدعى بعد نجاح الدخول أو التسجيل
async function issueSession(userId) {
  const token = newToken()
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)

  const { error } = await supabase
    .from('user_sessions')
    .insert({ token, user_id: userId, expires_at: expiresAt })

  if (error) throw error
  return token
}

async function revokeSession(token) {
  if (!token) return
  await supabase.from('user_sessions').delete().eq('token', token)
}

function bearer(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null
}

// ━━ الحارس الأساسي: يثبت الهوية ويضع req.userId ━━
async function requireUser(req, res, next) {
  try {
    const token = bearer(req)

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'يلزم تسجيل الدخول — حدّث التطبيق لآخر نسخة'
      })
    }

    const { data: session, error } = await supabase
      .from('user_sessions')
      .select('user_id, expires_at')
      .eq('token', token)
      .maybeSingle()

    if (error || !session) {
      return res.status(401).json({ success: false, message: 'الجلسة غير صالحة — سجّل الدخول من جديد' })
    }

    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('user_sessions').delete().eq('token', token)
      return res.status(401).json({ success: false, message: 'انتهت الجلسة — سجّل الدخول من جديد' })
    }

    // الحساب الموقوف أو المحذوف لا يُخدَم حتى لو كان رمزه صالحاً
    const { data: user } = await supabase
      .from('users')
      .select('id, is_active, deleted_at')
      .eq('id', session.user_id)
      .maybeSingle()

    if (!user || user.deleted_at || user.is_active === false) {
      await supabase.from('user_sessions').delete().eq('token', token)
      return res.status(403).json({ success: false, message: 'الحساب غير متاح' })
    }

    req.userId = session.user_id
    req.sessionToken = token
    next()
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر التحقق من الجلسة' })
  }
}

// ━━ التحقق من أن المورد يخص صاحب الجلسة ━━

// يرجع true إن كان مصرحاً، وإلا يرد 403 ويرجع false
function assertSelf(req, res, targetUserId) {
  if (req.userId && String(req.userId) === String(targetUserId)) return true
  res.status(403).json({ success: false, message: 'غير مصرح بهذا الإجراء' })
  return false
}

// معرّف متجر المستخدم الحالي (أو null)
async function chefOfUser(userId) {
  const { data } = await supabase
    .from('chefs')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()

  return data ? data.id : null
}

// هل chefId يخص صاحب الجلسة؟
async function assertChefOwner(req, res, chefId) {
  if (!chefId) {
    res.status(400).json({ success: false, message: 'معرّف المتجر مطلوب' })
    return false
  }

  const { data: chef } = await supabase
    .from('chefs')
    .select('user_id')
    .eq('id', chefId)
    .maybeSingle()

  if (!chef || String(chef.user_id) !== String(req.userId)) {
    res.status(403).json({ success: false, message: 'غير مصرح — هذا المتجر ليس لك' })
    return false
  }

  return true
}

// هل صنف القائمة يخص متجر صاحب الجلسة؟
async function assertMenuItemOwner(req, res, menuItemId) {
  const { data: item } = await supabase
    .from('menu_items')
    .select('chef_id')
    .eq('id', menuItemId)
    .maybeSingle()

  if (!item) {
    res.status(404).json({ success: false, message: 'المنتج غير موجود' })
    return false
  }

  return assertChefOwner(req, res, item.chef_id)
}

// هل حساب المندوب يخص صاحب الجلسة؟
async function assertDriverOwner(req, res, driverId) {
  const { data: driver } = await supabase
    .from('drivers')
    .select('user_id')
    .eq('id', driverId)
    .maybeSingle()

  if (!driver || String(driver.user_id) !== String(req.userId)) {
    res.status(403).json({ success: false, message: 'غير مصرح — هذا الحساب ليس لك' })
    return false
  }

  return true
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  حد المحاولات — بلا مكتبة خارجية
//  الغرض: منع تخمين كلمات المرور آلياً. الذاكرة تكفي لخادم واحد؛
//  عند التوسع لعدة نسخ يُنقل العدّاد لقاعدة البيانات أو Redis.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const attempts = new Map()

function rateLimit({ windowMs = 15 * 60 * 1000, max = 10, message } = {}) {
  return (req, res, next) => {
    const key = (req.ip || 'unknown') + ':' + req.path
    const now = Date.now()
    const rec = attempts.get(key)

    if (!rec || now > rec.resetAt) {
      attempts.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    rec.count += 1

    if (rec.count > max) {
      const mins = Math.ceil((rec.resetAt - now) / 60000)
      return res.status(429).json({
        success: false,
        message: message || `محاولات كثيرة — انتظر ${mins} دقيقة وحاول مرة ثانية`
      })
    }

    next()
  }
}

// تنظيف دوري حتى لا تنمو الذاكرة بلا حد
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of attempts) {
    if (now > v.resetAt) attempts.delete(k)
  }
}, 10 * 60 * 1000).unref?.()

module.exports = {
  rateLimit,
  issueSession,
  revokeSession,
  requireUser,
  assertSelf,
  chefOfUser,
  assertChefOwner,
  assertMenuItemOwner,
  assertDriverOwner,
}
