const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /chefs/search?q= — بحث شامل
//  يغطي: اسم المنتج + اسم المتجر + المدينة + الحي
//  (كان يبحث في أسماء المنتجات فقط، فالبحث بالمدينة لا يرجع شيئاً)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ success: true, data: [] })

    const chefsMap = new Map()

    const addChef = (chef, menu) => {
      if (!chef || chef.status === 'closed' || !chef.is_verified) return
      if (!chefsMap.has(chef.id)) {
        chefsMap.set(chef.id, { ...chef, menu: menu || [] })
      }
    }

    // ١. مطابقة اسم المتجر (في جدول users) — نجلب المتاجر التابعة للمستخدمين المطابقين
    const { data: matchedUsers } = await supabase
      .from('users')
      .select('id')
      .ilike('full_name', `%${q}%`)

    const matchedUserIds = (matchedUsers || []).map(u => u.id)

    // ٢. مطابقة المدينة أو الحي أو اسم المتجر
    let chefQuery = supabase
      .from('chefs')
      .select(`*, users ( full_name, avatar_url, phone ), menu:menu_items ( id, name, price, image_url, category, status )`)
      .neq('status', 'closed')
      .eq('is_verified', true)

    const orParts = [`city.ilike.%${q}%`, `neighborhood.ilike.%${q}%`]
    if (matchedUserIds.length > 0) {
      orParts.push(`user_id.in.(${matchedUserIds.join(',')})`)
    }

    const { data: chefsByInfo } = await chefQuery.or(orParts.join(','))

    ;(chefsByInfo || []).forEach(chef => {
      const menu = (chef.menu || []).filter(m => m.status !== 'unavailable')
      addChef(chef, menu)
    })

    // ٣. مطابقة أسماء المنتجات
    const { data: matchedItems, error: itemsErr } = await supabase
      .from('menu_items')
      .select(`*, chefs (*, users ( full_name, avatar_url, phone ))`)
      .ilike('name', `%${q}%`)
      .neq('status', 'unavailable')

    if (itemsErr) throw itemsErr

    ;(matchedItems || []).forEach(item => {
      const chef = item.chefs
      if (!chef || chef.status === 'closed' || !chef.is_verified) return

      const { chefs, ...menuItem } = item

      if (!chefsMap.has(chef.id)) {
        chefsMap.set(chef.id, { ...chef, menu: [menuItem] })
        return
      }

      // المتجر موجود من مطابقة سابقة — نضيف المنتج إن لم يكن مضافاً
      const existing = chefsMap.get(chef.id)
      if (!existing.menu.some(m => m.id === menuItem.id)) {
        existing.menu.push(menuItem)
      }
    })

    res.json({ success: true, data: Array.from(chefsMap.values()) })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /chefs — كل المتاجر المتاحة
//  status: open | preorder | closed
//  ملاحظة: menu_items تُرجع دائماً باسم menu — الواجهة تفلتر التصنيفات عليها
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/', async (req, res) => {
  try {
    const { city, status, user_id } = req.query

    let query = supabase
      .from('chefs')
      .select(`*, users ( full_name, avatar_url, phone ), menu:menu_items ( id, name, price, image_url, category, status )`)

    if (!user_id) query = query.eq('is_verified', true)
    if (city)    query = query.eq('city', city)
    if (user_id) query = query.eq('user_id', user_id)

    if (status) {
      // فلترة صريحة لحالة معينة (open أو preorder أو closed)
      query = query.eq('status', status)
    } else if (!user_id) {
      // افتراضياً للعميل: نخفي المتاجر المغلقة تماماً
      query = query.neq('status', 'closed')
    }

    const { data, error } = await query.order('rating_avg', { ascending: false })

    if (error) throw error

    // البث ينتهي تلقائياً بعد 4 ساعات — حتى لا تبقى الشارة مضاءة لمن نسي إطفاءها
    const LIVE_MAX_MS = 4 * 60 * 60 * 1000
    const now = Date.now()
    const expiredLive = []

    const clean = (data || []).map(chef => {
      let live = Boolean(chef.is_live)

      if (live) {
        const started = chef.live_started_at ? new Date(chef.live_started_at).getTime() : 0
        if (!started || now - started > LIVE_MAX_MS) {
          live = false
          expiredLive.push(chef.id)
        }
      }

      return {
        ...chef,
        is_live: live,
        live_url: live ? chef.live_url : null,
        live_item_id: live ? chef.live_item_id : null,
        live_item_price: live ? chef.live_item_price : null,
        // الأصناف غير المتوفرة لا تُحتسب في التصنيفات ولا تُعرض
        menu: (chef.menu || []).filter(item => item.status !== 'unavailable')
      }
    })

    // تنظيف صامت بالقاعدة — لا يعطل الرد إن فشل
    if (expiredLive.length > 0) {
      supabase
        .from('chefs')
        .update({ is_live: false, live_url: null, live_started_at: null, live_item_id: null, live_item_price: null })
        .in('id', expiredLive)
        .then(() => {}, () => {})
    }

    res.json({ success: true, data: clean })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /chefs/cert-grace — مهلة رفع شهادة العمل الحر (بالأيام)
//  المصدر الوحيد: app_settings (الأدمن يعدلها من لوحته)
//  ملاحظة: هذا المسار قبل /:id عمداً — ترتيب الراوتات حاسم
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/cert-grace', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'freelance_cert_grace_days')
      .single()

    if (error) throw error
    res.json({ success: true, data: { grace_days: parseInt(data.value, 10) || 30 } })
  } catch (err) {
    // في أسوأ الحالات نرجع 30 يوم كافتراض آمن بدل كسر لوحة المتجر
    res.json({ success: true, data: { grace_days: 30 } })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /chefs/:id — متجر معيّن + قائمته
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
//  PATCH /chefs/:id/toggle — تحديث حالة المتجر
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

    // عند التحويل لـ"حجز مسبق": كل المنتجات المتاحة تتحول تلقائياً لحجز مسبق أيضاً
    // (المنتجات اللي أصلاً "حجز مسبق" أو "غير متاحة" ما تتأثر — ما فيه تراجع تلقائي عكسي)
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /chefs/:id/offers — تحديث أنواع التقديم (مطبخ/عزائم/بوفيه/حلويات/معجنات/مشروبات)
//  body: أي من { offers_daily, offers_hospitality, offers_buffet, offers_sweets, offers_pastries, offers_drinks } (boolean)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/offers', async (req, res) => {
  try {
    const ALLOWED = ['offers_daily', 'offers_hospitality', 'offers_buffet', 'offers_sweets', 'offers_pastries', 'offers_drinks']
    const updates = {}

    for (const key of ALLOWED) {
      if (typeof req.body[key] === 'boolean') updates[key] = req.body[key]
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'ما فيه أي حقل صالح للتحديث' })
    }

    const { data, error } = await supabase
      .from('chefs')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /chefs/:id/live — تشغيل/إيقاف البث المباشر
//  body: { is_live, live_url?, live_item_id?, live_item_price? }
//
//  لا بث داخل التطبيق — نربط بث المتجر الموجود على تيك توك أو غيره.
//  إيقاف تلقائي بعد 4 ساعات يجري عند القراءة (انظر GET /chefs).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/live', async (req, res) => {
  try {
    const { is_live, live_url, live_item_id, live_item_price } = req.body

    if (typeof is_live !== 'boolean') {
      return res.status(400).json({ success: false, message: 'الحقل is_live مطلوب (true/false)' })
    }

    if (!is_live) {
      const { data, error } = await supabase
        .from('chefs')
        .update({
          is_live: false,
          live_url: null,
          live_started_at: null,
          live_item_id: null,
          live_item_price: null
        })
        .eq('id', req.params.id)
        .select()
        .single()

      if (error) throw error
      return res.json({ success: true, data })
    }

    const url = String(live_url || '').trim()
    if (!url) {
      return res.status(400).json({ success: false, message: 'رابط البث مطلوب' })
    }
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, message: 'رابط البث يجب أن يبدأ بـ https' })
    }

    // المتجر يجب أن يكون مفتوحاً — لا معنى لبث من متجر مغلق
    const { data: chef, error: chefErr } = await supabase
      .from('chefs')
      .select('id, status')
      .eq('id', req.params.id)
      .single()

    if (chefErr) throw chefErr
    if (chef.status === 'closed') {
      return res.status(400).json({ success: false, message: 'افتح متجرك أولاً قبل بدء البث' })
    }

    const updates = {
      is_live: true,
      live_url: url,
      live_started_at: new Date(),
      live_item_id: null,
      live_item_price: null
    }

    // منتج البث بسعر خاص — اختياري
    if (live_item_id) {
      const price = Number(live_item_price)
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ success: false, message: 'سعر منتج البث غير صحيح' })
      }

      const { data: item, error: itemErr } = await supabase
        .from('menu_items')
        .select('id, price, chef_id')
        .eq('id', live_item_id)
        .single()

      if (itemErr || !item || item.chef_id !== req.params.id) {
        return res.status(400).json({ success: false, message: 'المنتج غير موجود في متجرك' })
      }

      if (price >= Number(item.price)) {
        return res.status(400).json({ success: false, message: 'سعر البث يجب أن يكون أقل من السعر الأصلي' })
      }

      updates.live_item_id = live_item_id
      updates.live_item_price = price
    }

    const { data, error } = await supabase
      .from('chefs')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /chefs/:id/location — تحديث موقع المتجر (خط الطول/العرض)
//  body: { lat, lng }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/location', async (req, res) => {
  try {
    const { lat, lng } = req.body

    if (lat == null || lng == null) {
      return res.status(400).json({ success: false, message: 'الإحداثيات مطلوبة (lat, lng)' })
    }

    const { data, error } = await supabase
      .from('chefs')
      .update({ lat, lng })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /chefs/:id/freelance-cert — حفظ شهادة العمل الحر
//  body: { cert_url }
//  الحقل غير إلزامي بالتسجيل — يُرفع من لوحة المتجر خلال المهلة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/freelance-cert', async (req, res) => {
  try {
    const { cert_url } = req.body

    if (!cert_url || typeof cert_url !== 'string' || !cert_url.startsWith('https://')) {
      return res.status(400).json({ success: false, message: 'رابط الشهادة غير صالح' })
    }

    const { data, error } = await supabase
      .from('chefs')
      .update({
        freelance_cert_url: cert_url,
        freelance_cert_uploaded_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router