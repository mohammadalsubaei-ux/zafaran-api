const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('drivers')
      .select('*, users(full_name, phone, avatar_url)')
      .eq('id', req.params.id)
      .single()
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

router.get('/user/:user_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('drivers')
      .select('*, users(full_name, phone, avatar_url)')
      .eq('user_id', req.params.user_id)
      .single()
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

router.patch('/:id/availability', async (req, res) => {
  try {
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
    res.status(500).json({ success: false, message: err.message })
  }
})

router.get('/:id/orders', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*), users(full_name, phone), chefs(*, users(full_name))')
      .eq('driver_id', req.params.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

router.post('/:id/accept/:order_id', async (req, res) => {
  try {
    const { id: driver_id, order_id } = req.params
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
    await supabase.from('notifications').insert({
      user_id: order.customer_id,
      title: 'المندوب في الطريق',
      body: 'تم تعيين مندوب لطلبك وهو في طريقه اليك',
      type: 'order_delivering',
      data: { order_id }
    })
    res.json({ success: true, data: updated })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

router.post('/:id/delivered/:order_id', async (req, res) => {
  try {
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
    const { data: driver } = await supabase
      .from('drivers')
      .select('total_deliveries, total_earnings')
      .eq('id', driver_id)
      .single()
    if (driver) {
      await supabase.from('drivers').update({
        is_available: true,
        total_deliveries: (driver.total_deliveries || 0) + 1,
        total_earnings: parseFloat(((driver.total_earnings || 0) + (order.driver_share || 0)).toFixed(2))
      }).eq('id', driver_id)
    }
    await supabase.from('notifications').insert({
      user_id: order.customer_id,
      title: 'وصل طلبك',
      body: 'استمتع بوجبتك! لا تنسى التقييم',
      type: 'order_delivered',
      data: { order_id }
    })
    res.json({ success: true, data: updated })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

router.patch('/:id/location', async (req, res) => {
  try {
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
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router
