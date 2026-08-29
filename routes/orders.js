const express = require('express')
const { requireUser, assertChefOwner } = require('../auth')

// هل للمستخدم حق رؤية هذا الطلب؟ العميل، أو صاحب المتجر، أو المندوب المسند
async function canSeeOrder(userId, order) {
  if (!order) return false
  if (String(order.customer_id) === String(userId)) return true

  const { data: chef } = await supabase
    .from('chefs').select('user_id').eq('id', order.chef_id).maybeSingle()
  if (chef && String(chef.user_id) === String(userId)) return true

  if (order.driver_id) {
    const { data: drv } = await supabase
      .from('drivers').select('user_id').eq('id', order.driver_id).maybeSingle()
    if (drv && String(drv.user_id) === String(userId)) return true
  }

  return false
}
const router = express.Router()
const supabase = require('../supabase')
const notifyUser = require('../notify')
const getSettings = require('../settings')
const { STATUS_AR, TERMINAL_STATUSES, CHEF_TRANSITIONS, getOrderCore, applyStatusChange } = require('../orderStatus')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  حساب المسافة بين نقطتين (كم) — Haversine
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function calcDistanceKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  حساب رسوم التوصيل حسب المسافة
//  أول 4.99 كم = 10 ريال ثابت، بعدها +1 ريال لكل كم إضافي
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function calcDeliveryFee(distanceKm, s) {
  if (distanceKm == null) return s.delivery_base_fee // احتياطي إذا ما توفرت الإحداثيات
  if (distanceKm <= s.delivery_base_km) return s.delivery_base_fee
  return parseFloat((s.delivery_base_fee + Math.ceil(distanceKm - s.delivery_base_km) * s.delivery_per_km_fee).toFixed(2))
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /orders/delivery-settings — نِسب التوصيل للعرض بالتطبيق
//  (عام بدون توكن — أرقام عرض فقط، تتحكم بها لوحة الأدمن)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/delivery-settings', async (req, res) => {
  const s = await getSettings()
  res.json({
    success: true,
    data: {
      delivery_base_fee:   s.delivery_base_fee,
      delivery_base_km:    s.delivery_base_km,
      delivery_per_km_fee: s.delivery_per_km_fee
    }
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /orders — إنشاء طلب جديد
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/', requireUser, async (req, res) => {
  try {
    // العميل هو صاحب الجلسة — لا يُقبل customer_id من الجسم
    req.body.customer_id = req.userId

    const {
      customer_id,
      chef_id,
      items,
      delivery_address,
      delivery_lat,
      delivery_lng,
      payment_method,
      notes,
      order_type,     // 'instant' | 'preorder' — اختياري، افتراضياً instant
      proposed_time,  // مطلوب إذا order_type = 'preorder'
      requested_time  // اسم بديل يرسله cart.tsx — نقبله لضمان التوافق
    } = req.body

    // توحيد الاسمين: الفرونت إند يرسل requested_time، والباك إند التاريخي proposed_time
    const finalProposedTime = proposed_time || requested_time

    if (!customer_id || !chef_id) {
      return res.status(400).json({ success: false, message: 'بيانات العميل أو الشيف ناقصة' })

    }

    // حارس الإيقاف: الحساب الموقوف لا ينشئ طلبات
    const { data: customerRow } = await supabase
      .from('users')
      .select('is_active')
      .eq('id', customer_id)
      .single()

    if (customerRow && customerRow.is_active === false) {
      return res.status(403).json({ success: false, message: 'حسابك موقوف — للاستفسار تواصل مع دعم زعفران' })
    }

    const isPreorder = order_type === 'preorder'

    if (isPreorder && !finalProposedTime) {
      return res.status(400).json({ success: false, message: 'الطلب المسبق يحتاج تحديد وقت التسليم المطلوب' })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'السلة فارغة' })
    }

    const itemIds = items.map(i => i.menu_item_id).filter(Boolean)

    const { data: menuItems, error: menuErr } = await supabase
      .from('menu_items')
      .select('id, name, price, status, chef_id')
      .in('id', itemIds)

    if (menuErr) throw menuErr

    // ━━ العروض النشطة ━━
    // خامل تماماً بلا عروض: الاستعلام يرجع فارغاً فتبقى الأسعار كما هي حرفياً.
    // العمولة تُحسب على subtotal بعد الخصم — فلا نأخذ عمولة على ريال لم يُحصَّل.
    const nowIso = new Date().toISOString()

    const { data: activeOffers } = await supabase
      .from('offers')
      .select('id, menu_item_id, discount_type, discount_value, max_discount_amount, usage_limit, usage_count, starts_at, ends_at')
      .eq('chef_id', chef_id)
      .eq('is_active', true)
      .lte('starts_at', nowIso)

    const usableOffers = (activeOffers || []).filter(o => {
      if (o.ends_at && new Date(o.ends_at) < new Date()) return false
      if (o.usage_limit != null && Number(o.usage_count) >= Number(o.usage_limit)) return false
      return true
    })

    // عرض المنتج أولى من عرض المتجر العام
    const offerFor = (menuItemId) =>
      usableOffers.find(o => o.menu_item_id === menuItemId) ||
      usableOffers.find(o => !o.menu_item_id) ||
      null

    const discountedPrice = (basePrice, offer) => {
      if (!offer) return basePrice

      let off = offer.discount_type === 'percent'
        ? basePrice * (Number(offer.discount_value) / 100)
        : Number(offer.discount_value)

      if (offer.max_discount_amount != null) {
        off = Math.min(off, Number(offer.max_discount_amount))
      }

      const final = basePrice - off
      // لا سعر سالب ولا مجاني بالخطأ
      return final > 0 ? parseFloat(final.toFixed(2)) : basePrice
    }

    let subtotal = 0
    let discountTotal = 0
    let appliedOfferId = null

    const orderItems = items.map(item => {
      const menuItem = menuItems.find(m => m.id === item.menu_item_id)

      if (!menuItem) throw new Error('أحد المنتجات غير موجود')

      // حراس المنتج: الانتماء لنفس المتجر + الحالة الثلاثية
      if (menuItem.chef_id !== chef_id) {
        throw new Error('أحد المنتجات لا يتبع هذا المتجر')
      }
      const itemStatus = menuItem.status || 'available'
      if (itemStatus === 'unavailable') {
        throw new Error('"' + menuItem.name + '" غير متوفر حالياً — احذفه من السلة وحاول من جديد')
      }
      if (itemStatus === 'preorder' && !isPreorder) {
        throw new Error('"' + menuItem.name + '" متاح بالحجز المسبق فقط — اختر وقتاً للتسليم')
      }

      const quantity  = Number(item.quantity || 1)
      const basePrice = Number(menuItem.price || 0)

      const offer = offerFor(item.menu_item_id)
      const price = discountedPrice(basePrice, offer)

      if (offer && price < basePrice) {
        discountTotal += (basePrice - price) * quantity
        if (!appliedOfferId) appliedOfferId = offer.id
      }

      const lineTotal = price * quantity
      subtotal += lineTotal

      return {
        menu_item_id: item.menu_item_id,
        name: menuItem.name,
        price,
        quantity,
        subtotal: lineTotal
      }
    })

    discountTotal = parseFloat(discountTotal.toFixed(2))

    const isPickup = delivery_address === 'استلام شخصي'

    // إعدادات المنصة الحية (النِّسب والرسوم من لوحة الأدمن)
    const s = await getSettings()

    // جلب إحداثيات الشيف ونسبة عمولته المخصصة لحساب المسافة والحصص
    const { data: chefLocation } = await supabase
      .from('chefs')
      .select('lat, lng, user_id, commission_rate, status')
      .eq('id', chef_id)
      .single()

    // حراس المتجر: الوجود + الحالة الثلاثية
    if (!chefLocation) {
      return res.status(404).json({ success: false, message: 'المتجر غير موجود' })
    }

    // حارس الطلب الذاتي: صاحب المتجر لا يطلب من متجره
    // (يولّد عمولة وحصصاً وهمية في الدفتر ويضخّم عداد الطلبات والتقييمات)
    if (chefLocation.user_id === customer_id) {
      return res.status(403).json({ success: false, message: 'لا يمكنك الطلب من متجرك — تصفح متاجر أخرى' })
    }

    const chefStatus = chefLocation.status || 'open'
    if (chefStatus === 'closed') {
      return res.status(403).json({ success: false, message: 'المتجر مغلق حالياً — جرب لاحقاً أو تصفح متاجر أخرى' })
    }
    if (chefStatus === 'preorder' && !isPreorder) {
      return res.status(400).json({ success: false, message: 'هذا المتجر يستقبل الطلبات المسبقة فقط حالياً — اختر وقتاً للتسليم' })
    }

    const distance_km = isPickup
      ? 0
      : calcDistanceKm(
          chefLocation?.lat, chefLocation?.lng,
          delivery_lat, delivery_lng
        )

    // حارس الإحداثيات: طلب توصيل بدون موقع صالح يُرفض
    // (بدونه تُحتسب الرسوم الأساسية مهما بعدت المسافة)
    if (!isPickup && distance_km == null) {
      return res.status(400).json({ success: false, message: 'تعذر تحديد موقع التوصيل — حدد موقعك من جديد ثم أعد المحاولة' })
    }

    const delivery_fee = isPickup ? 0 : calcDeliveryFee(distance_km, s)

    // عمولة المنصة: نسبة الشيف المخصصة إن وُجدت، وإلا النسبة العامة من الإعدادات
    let commissionRate = parseFloat(chefLocation?.commission_rate)
    if (!isFinite(commissionRate) || commissionRate < 0) commissionRate = s.platform_commission_rate
    if (commissionRate > 1) commissionRate = commissionRate / 100 // تطبيع: 17 تعني 17%

    const platform_fee_order    = parseFloat((subtotal * commissionRate).toFixed(2))
    // عمولة التوصيل: نسبة من الإعدادات مقرّبة للأعلى لصالح زعفران، الباقي (بما فيه الكسور) للمندوب
    const platform_fee_delivery = isPickup ? 0 : Math.ceil(delivery_fee * s.delivery_platform_rate)
    const platform_fee          = parseFloat((platform_fee_order + platform_fee_delivery).toFixed(2))
    const chef_share            = parseFloat((subtotal - platform_fee_order).toFixed(2))
    const driver_share          = isPickup ? 0 : parseFloat((delivery_fee - platform_fee_delivery).toFixed(2))
    const total                 = parseFloat((subtotal + delivery_fee).toFixed(2))

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        customer_id,
        chef_id,
        delivery_address,
        delivery_lat,
        delivery_lng,
        distance_km: distance_km != null ? parseFloat(distance_km.toFixed(2)) : null,
        order_type: isPreorder ? 'preorder' : 'instant',
        proposed_time: isPreorder ? finalProposedTime : null,
        time_negotiation_status: isPreorder ? 'pending' : null,
        subtotal,
        delivery_fee,
        platform_fee,
        chef_share,
        driver_share,
        total,
        payment_method,
        notes,
        discount_amount: discountTotal,
        offer_id: appliedOfferId,
        status: 'pending',
        payment_status: 'pending'
      })
      .select()
      .single()

    if (orderErr) throw orderErr

    const itemsWithOrder = orderItems.map(i => ({ ...i, order_id: order.id }))
    const { error: itemsErr } = await supabase.from('order_items').insert(itemsWithOrder)
    if (itemsErr) throw itemsErr

    // عدّاد استخدام العرض — لا يعطل الطلب إن فشل
    if (appliedOfferId) {
      const used = usableOffers.find(o => o.id === appliedOfferId)
      if (used) {
        supabase
          .from('offers')
          .update({ usage_count: Number(used.usage_count || 0) + 1 })
          .eq('id', appliedOfferId)
          .then(() => {}, () => {})
      }
    }

    if (chefLocation) {
      await notifyUser(
        chefLocation.user_id,
        isPreorder ? 'طلب مسبق جديد — بانتظار تأكيد الوقت' : 'طلب جديد',
        isPreorder
          ? `عميل يقترح موعد ${finalProposedTime} لطلب بقيمة ${total} ريال`
          : `وصلك طلب جديد بقيمة ${total} ريال`,
        isPreorder ? 'preorder_time_proposed' : 'order_new',
        { order_id: order.id }
      )
    }

    res.status(201).json({ success: true, data: { ...order, items: orderItems } })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /orders/customer/:id
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/customer/:id', requireUser, async (req, res) => {
  try {
    if (String(req.userId) !== String(req.params.id)) {
      return res.status(403).json({ success: false, message: 'غير مصرح' })
    }

    // بلا حد كان يُرجع كل الطلبات بأصنافها — يبطئ الشاشة ويثقل الخادم مع النمو
    const limit  = Math.min(Number(req.query.limit) || 30, 100)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    const { data, error } = await supabase
      .from('orders')
      .select(`*, order_items(*), chefs(*, users(full_name, gender))`)
      .eq('customer_id', req.params.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /orders/chef/:id
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/chef/:id', requireUser, async (req, res) => {
  try {
    // سجل طلبات المتجر يكشف دخله وعملاءه — لصاحبه وحده
    if (!(await assertChefOwner(req, res, req.params.id))) return

    const limit  = Math.min(Number(req.query.limit) || 30, 100)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    const { data, error } = await supabase
      .from('orders')
      .select(`*, order_items(*), users(full_name, phone)`)
      .eq('chef_id', req.params.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /orders?status=ready
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/', requireUser, async (req, res) => {
  try {
    // قائمة الطلبات المتاحة للالتقاط — للمندوبين الموثّقين وحدهم.
    // كانت مفتوحة تماماً فتكشف كل طلبات المنصة بأسماء العملاء وأرقامهم.
    const { data: driver } = await supabase
      .from('drivers')
      .select('id, is_verified')
      .eq('user_id', req.userId)
      .maybeSingle()

    if (!driver || !driver.is_verified) {
      return res.status(403).json({ success: false, message: 'غير مصرح' })
    }

    const { status } = req.query
    let query = supabase
      .from('orders')
      .select(`*, order_items(*), users(full_name, phone)`)
      .order('created_at', { ascending: false })
      .limit(Math.min(Number(req.query.limit) || 50, 100))

    if (status) query = query.eq('status', status)

    // طلبات الاستلام الشخصي لا تعرض بقائمة المناديب المتاحة أبداً
    if (status === 'ready') query = query.or('delivery_address.is.null,delivery_address.neq.استلام شخصي')

    const { data, error } = await query
    if (error) throw error

    // المندوب لا يرى قيمة الطلب الكاملة أبداً (قرار خصوصية محسوم)،
    // ولا يرى اسم العميل ورقمه إلا بعد أن يُسند الطلب إليه — فهو يحتاجهما للتسليم.
    const trimmed = (data || []).map(o => {
      const mine = String(o.driver_id || '') === String(driver.id)

      return {
        ...o,
        users: mine ? o.users : undefined,
        subtotal: undefined,
        platform_fee: undefined,
        chef_share: undefined,
        discount_amount: undefined
      }
    })

    res.json({ success: true, data: trimmed })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /orders/:id
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:id', requireUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`*, order_items(*), users(full_name, phone), chefs(*, users(full_name, gender, phone))`)
      .eq('id', req.params.id)
      .single()

    if (error) throw error

    // الطلب يحمل اسم العميل ورقمه وعنوانه — لا يراه إلا أطرافه الثلاثة
    if (!(await canSeeOrder(req.userId, data))) {
      return res.status(403).json({ success: false, message: 'غير مصرح بعرض هذا الطلب' })
    }

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /orders/:id/status
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/status', requireUser, async (req, res) => {
  try {
    const { status, cancel_reason } = req.body
    const user_id = req.userId

    const chefUsable = ['accepted', 'preparing', 'ready', 'delivered', 'cancelled']
    if (!chefUsable.includes(status)) {
      return res.status(400).json({ success: false, message: 'حالة غير صحيحة' })
    }
    if (!user_id) {
      return res.status(401).json({ success: false, message: 'التحقق من الهوية مطلوب — حدّث التطبيق لآخر نسخة' })
    }

    const order = await getOrderCore(req.params.id)
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' })
    }

    if (TERMINAL_STATUSES.includes(order.status)) {
      return res.status(409).json({ success: false, message: 'الطلب بحالة نهائية (' + STATUS_AR[order.status] + ') ولا يمكن تعديله' })
    }

    // تحديد المتصرف: صاحب المتجر أم العميل صاحب الطلب
    const { data: chef } = await supabase
      .from('chefs')
      .select('user_id')
      .eq('id', order.chef_id)
      .single()

    const isChefActor = !!chef && chef.user_id === user_id
    const isCustomerActor = order.customer_id === user_id

    if (!isChefActor && !isCustomerActor) {
      return res.status(403).json({ success: false, message: 'غير مصرح بتعديل هذا الطلب' })
    }

    // مسار العميل: إلغاء فقط، وقبل قبول المتجر للطلب
    if (isCustomerActor && !isChefActor) {
      if (status !== 'cancelled') {
        return res.status(403).json({ success: false, message: 'غير مصرح — يمكنك إلغاء الطلب فقط' })
      }
      if (!['pending', 'pending_time'].includes(order.status)) {
        return res.status(409).json({ success: false, message: 'ما عاد يمكن الإلغاء — المتجر بدأ بتجهيز طلبك، تواصل مع الدعم وسنساعدك' })
      }
      const updated = await applyStatusChange(order, 'cancelled', {
        cancel_reason: cancel_reason && cancel_reason.trim() ? cancel_reason.trim() : 'ألغاه العميل',
        cancelled_by: 'customer',
        notifyChef: true
      })
      return res.json({ success: true, data: updated })
    }

    // استلام شخصي: الشيف يوثق تسليم العميل بنفسه من حالة "جاهز" فقط
    if (status === 'delivered') {
      if (order.delivery_address !== 'استلام شخصي' || order.status !== 'ready') {
        return res.status(409).json({ success: false, message: 'تسليم طلبات التوصيل يتم عبر المندوب' })
      }
    } else {
      const allowed = CHEF_TRANSITIONS[order.status] || []
      if (!allowed.includes(status)) {
        return res.status(409).json({ success: false, message: 'لا يمكن الانتقال من "' + STATUS_AR[order.status] + '" إلى "' + STATUS_AR[status] + '"' })
      }
    }

    const updated = await applyStatusChange(order, status, { cancel_reason, cancelled_by: 'chef' })
    res.json({ success: true, data: updated })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /orders/:id/renotify-drivers — العميل يعيد نداء المناديب عند طول الانتظار
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/:id/renotify-drivers', requireUser, async (req, res) => {
  try {
    const { user_id } = req.body
    if (!user_id) {
      return res.status(401).json({ success: false, message: 'التحقق من الهوية مطلوب' })
    }

    const order = await getOrderCore(req.params.id)
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' })
    }
    if (order.customer_id !== user_id) {
      return res.status(403).json({ success: false, message: 'غير مصرح' })
    }
    if (order.status !== 'ready' || order.driver_id) {
      return res.status(409).json({ success: false, message: 'الطلب ليس بانتظار مندوب' })
    }
    if (order.delivery_address === 'استلام شخصي') {
      return res.status(400).json({ success: false, message: 'هذا طلب استلام شخصي' })
    }

    const { data: availableDrivers } = await supabase
      .from('drivers')
      .select('id, user_id')
      .eq('is_available', true)

    if (availableDrivers && availableDrivers.length > 0) {
      await Promise.all(
        availableDrivers.map(driver =>
          notifyUser(
            driver.user_id,
            'طلب توصيل بانتظارك',
            'عميل ينتظر مندوباً منذ دقائق — اضغط لقبول الطلب',
            'delivery_request',
            { order_id: order.id }
          )
        )
      )
    }

    res.json({ success: true, notified: availableDrivers ? availableDrivers.length : 0 })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /orders/:id/switch-to-pickup — تحويل العميل طلبه لاستلام شخصي
//  (خياره عند غياب المناديب) مع إعادة تسعير كاملة: حذف رسوم التوصيل وحصصها
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/:id/switch-to-pickup', requireUser, async (req, res) => {
  try {
    const user_id = req.userId
    if (!user_id) {
      return res.status(401).json({ success: false, message: 'التحقق من الهوية مطلوب' })
    }

    const order = await getOrderCore(req.params.id)
    if (!order) {
      return res.status(404).json({ success: false, message: 'الطلب غير موجود' })
    }
    if (order.customer_id !== user_id) {
      return res.status(403).json({ success: false, message: 'غير مصرح' })
    }
    if (order.status !== 'ready' || order.driver_id) {
      return res.status(409).json({ success: false, message: 'التحويل متاح فقط والطلب جاهز بانتظار مندوب' })
    }
    if (order.delivery_address === 'استلام شخصي') {
      return res.status(400).json({ success: false, message: 'الطلب استلام شخصي أصلاً' })
    }

    const { data: full } = await supabase
      .from('orders')
      .select('subtotal, chef_share, delivery_fee')
      .eq('id', order.id)
      .single()

    const subtotal  = Number(full?.subtotal || 0)
    const chefShare = Number(full?.chef_share || 0)
    const savedFee  = Number(full?.delivery_fee || 0)

    const { data: updated, error } = await supabase
      .from('orders')
      .update({
        delivery_address: 'استلام شخصي',
        delivery_fee: 0,
        driver_share: 0,
        platform_fee: parseFloat((subtotal - chefShare).toFixed(2)),
        total: parseFloat(subtotal.toFixed(2))
      })
      .eq('id', order.id)
      .select('*')
      .single()

    if (error) throw error

    const { data: chefRow } = await supabase
      .from('chefs')
      .select('user_id')
      .eq('id', order.chef_id)
      .single()

    if (chefRow?.user_id) {
      await notifyUser(
        chefRow.user_id,
        'تحول لاستلام شخصي',
        'العميل سيستلم الطلب بنفسه من موقعكم — بانتظار وصوله',
        'order_pickup_switch',
        { order_id: order.id }
      )
    }

    await notifyUser(
      order.customer_id,
      'تم التحويل لاستلام شخصي',
      savedFee > 0
        ? 'وفرت رسوم التوصيل (' + savedFee.toFixed(2) + ' ر.س) — استلم طلبك من موقع المتجر'
        : 'استلم طلبك من موقع المتجر',
      'order_pickup_switch',
      { order_id: order.id }
    )

    res.json({ success: true, data: updated })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /orders/:id/confirm-time — رد الشيف على الوقت المقترح
//  body: { action: 'accept' | 'counter', counter_time? }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/confirm-time', requireUser, async (req, res) => {
  try {
    const { action, counter_time, confirmed_time } = req.body

    // توحيد الأسماء: الفرونت إند يرسل confirm/propose + confirmed_time
    // بينما التوثيق التاريخي يستخدم accept/counter + counter_time — نقبل الاثنين
    const normalizedAction = action === 'confirm' ? 'accept'
                            : action === 'propose' ? 'counter'
                            : action

    const finalCounterTime = counter_time || confirmed_time

    if (!['accept', 'counter'].includes(normalizedAction)) {
      return res.status(400).json({ success: false, message: 'action يجب أن تكون accept/confirm أو counter/propose' })
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('orders')
      .select('id, order_type, proposed_time, time_negotiation_status, customer_id')
      .eq('id', req.params.id)
      .single()

    if (fetchErr) throw fetchErr

    if (existing.order_type !== 'preorder') {
      return res.status(400).json({ success: false, message: 'هذا الطلب ليس طلباً مسبقاً' })
    }

    if (existing.time_negotiation_status !== 'pending') {
      return res.status(400).json({ success: false, message: 'تم الرد على هذا الطلب مسبقاً' })
    }

    let updates = {}

    if (normalizedAction === 'accept') {
      updates = {
        time_negotiation_status: 'accepted',
        // إذا الشيف حدد وقت بالضبط (حتى لو مطابق لطلب العميل) نستخدمه، وإلا نرجع لوقت العميل المقترح
        confirmed_time: finalCounterTime || existing.proposed_time
      }
    } else {
      if (!finalCounterTime) {
        return res.status(400).json({ success: false, message: 'الوقت البديل مطلوب عند اقتراح موعد آخر' })
      }
      updates = {
        time_negotiation_status: 'chef_countered',
        confirmed_time: finalCounterTime
      }
    }

    const { data: order, error } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error

    await notifyUser(
      order.customer_id,
      normalizedAction === 'accept' ? 'المتجر أكد وقت طلبك' : 'المتجر اقترح وقتاً بديلاً',
      normalizedAction === 'accept'
        ? 'تم تأكيد موعد طلبك، يمكنك إتمام الدفع الآن'
        : `المتجر اقترح موعد ${finalCounterTime} بدل موعدك — وافق أو ألغِ الطلب`,
      normalizedAction === 'accept' ? 'preorder_time_accepted' : 'preorder_time_countered',
      { order_id: order.id }
    )

    res.json({ success: true, data: order })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /orders/:id/respond-time — رد العميل على اقتراح الشيف البديل
//  body: { action: 'accept' | 'reject' }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:id/respond-time', requireUser, async (req, res) => {
  try {
    const { action } = req.body

    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action يجب أن تكون accept أو reject' })
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('orders')
      .select('id, order_type, confirmed_time, time_negotiation_status, chef_id, chefs(user_id)')
      .eq('id', req.params.id)
      .single()

    if (fetchErr) throw fetchErr

    if (existing.time_negotiation_status !== 'chef_countered') {
      return res.status(400).json({ success: false, message: 'لا يوجد اقتراح بديل بانتظار ردك' })
    }

    const updates = action === 'accept'
      ? { time_negotiation_status: 'accepted', proposed_time: existing.confirmed_time }
      : { time_negotiation_status: 'rejected', status: 'cancelled' } // إلغاء بدون رسوم

    const { data: order, error } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error

    const chefUserId = existing.chefs?.user_id
    if (chefUserId) {
      await notifyUser(
        chefUserId,
        action === 'accept' ? 'العميل وافق على الوقت البديل' : 'العميل ألغى الطلب',
        action === 'accept'
          ? 'العميل وافق على الموعد المقترح، يمكنك البدء بعد إتمام الدفع'
          : 'العميل رفض الوقت البديل وتم إلغاء الطلب بدون رسوم',
        action === 'accept' ? 'preorder_time_finalized' : 'preorder_cancelled',
        { order_id: order.id }
      )
    }

    res.json({ success: true, data: order })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /orders/:id/review
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/:id/review', requireUser, async (req, res) => {
  try {
    const order_id = req.params.id
    const { rating, comment } = req.body
    const customer_id = req.userId
    const numericRating = Number(rating)

    if (!customer_id) {
      return res.status(400).json({ success: false, message: 'معرف العميل مطلوب' })
    }

    if (!numericRating || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ success: false, message: 'التقييم يجب أن يكون بين 1 و 5' })
    }

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, chef_id, customer_id, status')
      .eq('id', order_id)
      .single()

    if (orderErr) throw orderErr

    if (order.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'لا يمكن التقييم إلا بعد التسليم' })
    }

    if (String(order.customer_id) !== String(customer_id)) {
      return res.status(403).json({ success: false, message: 'غير مصرح' })
    }

    // التقييم المكرر يُحدَّث ولا يُرفض — العميل يعدّل رأيه بدل أن يواجه خطأ
    const { data: existingReview } = await supabase
      .from('reviews')
      .select('id')
      .eq('order_id', order_id)
      .maybeSingle()

    let review = null

    if (existingReview) {
      const { data: updated, error: updateErr } = await supabase
        .from('reviews')
        .update({
          rating: numericRating,
          comment: comment ? String(comment).trim() : null
        })
        .eq('id', existingReview.id)
        .select()
        .single()

      if (updateErr) throw updateErr
      review = updated
    } else {
      const { data: created, error: reviewErr } = await supabase
        .from('reviews')
        .insert({
          order_id,
          customer_id,
          chef_id: order.chef_id,
          rating: numericRating,
          comment: comment ? String(comment).trim() : null
        })
        .select()
        .single()

      if (reviewErr) throw reviewErr
      review = created
    }

    const { data: allReviews } = await supabase
      .from('reviews')
      .select('rating')
      .eq('chef_id', order.chef_id)

    if (allReviews && allReviews.length > 0) {
      const avg = allReviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / allReviews.length
      await supabase
        .from('chefs')
        .update({
          rating_avg: parseFloat(avg.toFixed(2)),
          rating_count: allReviews.length
        })
        .eq('id', order.chef_id)
    }

    res.status(existingReview ? 200 : 201).json({
      success: true,
      data: review,
      updated: Boolean(existingReview)
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /orders/:id/review
//  يُرجع تقييم الطلب إن وُجد — لتعرضه الشاشة بدل نموذج فارغ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:id/review', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('id, rating, comment, created_at')
      .eq('order_id', req.params.id)
      .maybeSingle()

    if (error) throw error

    res.json({ success: true, data: data || null })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

module.exports = router