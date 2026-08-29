const express = require('express')
const { requireUser, assertDriverOwner } = require('../auth')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /tracking/:orderId — جلب آخر موقع معروف للمندوب على هذا الطلب
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:orderId', requireUser, async (req, res) => {
  try {
    // الموقع اللحظي للمندوب — لأطراف الطلب وحدهم
    const { data: order } = await supabase
      .from('orders')
      .select('customer_id, chef_id, driver_id')
      .eq('id', req.params.orderId)
      .maybeSingle()

    if (!order) return res.json({ success: true, data: null })

    let allowed = String(order.customer_id) === String(req.userId)

    if (!allowed) {
      const { data: chef } = await supabase
        .from('chefs').select('user_id').eq('id', order.chef_id).maybeSingle()
      allowed = Boolean(chef && String(chef.user_id) === String(req.userId))
    }

    if (!allowed && order.driver_id) {
      const { data: drv } = await supabase
        .from('drivers').select('user_id').eq('id', order.driver_id).maybeSingle()
      allowed = Boolean(drv && String(drv.user_id) === String(req.userId))
    }

    if (!allowed) {
      return res.status(403).json({ success: false, message: 'غير مصرح' })
    }

    const { data, error } = await supabase
      .from('driver_locations')
      .select('*')
      .eq('order_id', req.params.orderId)
      .single()

    // ما فيه موقع محفوظ بعد (طلب لسا ما بدأ التوصيل) — نرجع data:null بدل خطأ
    if (error || !data) {
      return res.json({ success: true, data: null })
    }

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /tracking/:orderId — المندوب يرسل موقعه الحالي أثناء التوصيل
//  body: { driver_id, lat, lng, heading, speed }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:orderId', requireUser, async (req, res) => {
  try {
    const { driver_id, lat, lng, heading, speed } = req.body

    // بلا هذا الفحص يزوّر أي شخص موقع أي مندوب
    if (!(await assertDriverOwner(req, res, driver_id))) return
    const orderId = req.params.orderId

    if (!driver_id || lat == null || lng == null) {
      return res.status(400).json({ success: false, message: 'بيانات الموقع ناقصة' })
    }

    await supabase.from('driver_locations').upsert({
      order_id: orderId,
      driver_id,
      lat, lng, heading, speed,
      updated_at: new Date().toISOString()
    }, { onConflict: 'order_id' })

    await supabase.from('orders')
      .update({ driver_lat: lat, driver_lng: lng })
      .eq('id', orderId)

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

module.exports = router