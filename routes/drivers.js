const express = require('express')
const { requireUser, assertSelf, assertDriverOwner } = require('../auth')
const router = express.Router()
const supabase = require('../supabase')
const notifyUser = require('../notify')
const { creditDeliveredOrder } = require('../orderStatus')

router.get('/:id', requireUser, async (req, res) => {
  try {
    if (!(await assertDriverOwner(req, res, req.params.id))) return

    const { data, error } = await supabase
      .from('drivers')
      .select('*, users(full_name, phone, avatar_url)')
      .eq('id', req.params.id)
      .single()
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

router.get('/user/:user_id', requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.user_id)) return

  try {
    const { data, error } = await supabase
      .from('drivers')
      .select('*, users(full_name, phone, avatar_url)')
      .eq('user_id', req.params.user_id)
      .single()
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

router.patch('/:id/availability', requireUser, async (req, res) => {
  try {
    if (!(await assertDriverOwner(req, res, req.params.id))) return

    const { is_available } = req.body
    const { data, error } = await supabase
      .from('drivers')
      .update({ is_available })
      .eq('id', req.params.id)
      .select()
      .single()
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

router.get('/:id/orders', requireUser, async (req, res) => {
  try {
    if (!(await assertDriverOwner(req, res, req.params.id))) return

    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*), users(full_name, phone), chefs(*, users(full_name))')
      .eq('driver_id', req.params.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

router.post('/:id/accept/:order_id', requireUser, async (req, res) => {
  try {
    if (!(await assertDriverOwner(req, res, req.params.id))) return

    const { id: driver_id, order_id } = req.params

    // حارس: تأكد أن المندوب موجود وموثّق قبل ربط أي طلب به
    // (يمنع أخطاء foreign key الغامضة ويرجع رسالة واضحة بدلها)
    const { data: driver, error: driverErr } = await supabase
      .from('drivers')
      .select('id, is_verified')
      .eq('id', driver_id)
      .single()
    if (driverErr || !driver) {
      return res.status(404).json({ success: false, message: 'ملف المندوب غير موجود — سجل خروجا ثم ادخل من جديد' })
    }
    if (!driver.is_verified) {
      return res.status(403).json({ success: false, message: 'حسابك قيد المراجعة — بنرسل لك اشعارا فور التوثيق' })
    }

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, status, driver_id, customer_id, total, driver_share')
      .eq('id', order_id)
      .single()
    if (orderErr) throw orderErr
    if (order.status !== 'ready') {
      return res.status(400).json({ success: false, message: 'الطلب لم يعد متاحا للاستلام' })
    }
    if (order.driver_id) {
      return res.status(409).json({ success: false, message: 'تم استلام الطلب من مندوب اخر' })
    }
    const { data: updated, error: updateErr } = await supabase
      .from('orders')
      .update({ driver_id, status: 'delivering' })
      .eq('id', order_id)
      .eq('status', 'ready')
      .select()
      .single()
    if (updateErr) throw updateErr
    if (!updated) {
      return res.status(409).json({ success: false, message: 'تم استلام الطلب من مندوب اخر' })
    }
    await supabase.from('drivers').update({ is_available: false }).eq('id', driver_id)
    await notifyUser(
      order.customer_id,
      'المندوب في الطريق',
      'تم تعيين مندوب لطلبك وهو في طريقه اليك',
      'order_delivering',
      { order_id }
    )
    res.json({ success: true, data: updated })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

router.post('/:id/delivered/:order_id', requireUser, async (req, res) => {
  try {
    if (!(await assertDriverOwner(req, res, req.params.id))) return

    const { id: driver_id, order_id } = req.params
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, status, driver_id, customer_id, driver_share')
      .eq('id', order_id)
      .single()
    if (orderErr) throw orderErr
    if (order.driver_id !== driver_id) {
      return res.status(403).json({ success: false, message: 'غير مصرح' })
    }
    if (order.status !== 'delivering') {
      return res.status(400).json({ success: false, message: 'حالة الطلب غير صحيحة' })
    }
    const { data: updated, error: updateErr } = await supabase
      .from('orders')
      .update({ status: 'delivered', delivered_at: new Date() })
      .eq('id', order_id)
      .select()
      .single()
    if (updateErr) throw updateErr
    // العدادات (total_deliveries / total_earnings) وإرجاع الحالة "متاح" يحدّثها الآن
    // trigger قاعدة البيانات الموحّد (trg_delivery_stats) لحظة التسليم من أي مسار —
    // لا نلمسها هنا إطلاقاً لتجنب العدّ المزدوج

    // ترصيد أرباح الشيف والمندوب بالمحافظ (محصّن ضد الازدواج داخلياً)
    await creditDeliveredOrder(order_id)
    await notifyUser(
      order.customer_id,
      'وصل طلبك',
      'استمتع بوجبتك! لا تنسى التقييم',
      'order_delivered',
      { order_id }
    )
    res.json({ success: true, data: updated })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

router.patch('/:id/location', requireUser, async (req, res) => {
  try {
    if (!(await assertDriverOwner(req, res, req.params.id))) return

    const { lat, lng, heading, speed, order_id } = req.body
    if (order_id) {
      await supabase.from('driver_locations').upsert({
        order_id,
        driver_id: req.params.id,
        lat, lng, heading, speed,
        updated_at: new Date()
      }, { onConflict: 'order_id' })
      await supabase.from('orders')
        .update({ driver_lat: lat, driver_lng: lng })
        .eq('id', order_id)
    }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

module.exports = router