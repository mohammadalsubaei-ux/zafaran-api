const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /tracking/:orderId — جلب آخر موقع معروف للمندوب على هذا الطلب
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:orderId', async (req, res) => {
  try {
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
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH /tracking/:orderId — المندوب يرسل موقعه الحالي أثناء التوصيل
//  body: { driver_id, lat, lng, heading, speed }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.patch('/:orderId', async (req, res) => {
  try {
    const { driver_id, lat, lng, heading, speed } = req.body
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
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router