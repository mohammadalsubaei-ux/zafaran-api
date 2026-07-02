const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
//  POST /orders â€” ط¥ظ†ط´ط§ط، ط·ظ„ط¨ ط¬ط¯ظٹط¯
// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
router.post('/', async (req, res) => {
  try {
    const {
      customer_id,
      chef_id,
      items,
      delivery_address,
      delivery_lat,
      delivery_lng,
      payment_method,
      notes
    } = req.body

    if (!customer_id || !chef_id) {
      return res.status(400).json({ success: false, message: 'ط¨ظٹط§ظ†ط§طھ ط§ظ„ط¹ظ…ظٹظ„ ط£ظˆ ط§ظ„ط´ظٹظپ ظ†ط§ظ‚طµط©' })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'ط§ظ„ط³ظ„ط© ظپط§ط±ط؛ط©' })
    }

    const itemIds = items.map(i => i.menu_item_id).filter(Boolean)

    const { data: menuItems, error: menuErr } = await supabase
      .from('menu_items')
      .select('id, name, price')
      .in('id', itemIds)

    if (menuErr) throw menuErr

    let subtotal = 0

    const orderItems = items.map(item => {
      const menuItem = menuItems.find(m => m.id === item.menu_item_id)

      if (!menuItem) throw new Error('ط£ط­ط¯ ط§ظ„ظ…ظ†طھط¬ط§طھ ط؛ظٹط± ظ…ظˆط¬ظˆط¯')

      const quantity = Number(item.quantity || 1)
      const price = Number(menuItem.price || 0)
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

    const isPickup = delivery_address === 'ط§ط³طھظ„ط§ظ… ط´ط®طµظٹ'
    const delivery_fee = isPickup ? 0 : 10.00

    const platform_fee_order    = parseFloat((subtotal * 0.17).toFixed(2))
    const platform_fee_delivery = isPickup ? 0 : parseFloat((delivery_fee * 0.10).toFixed(2))
    const platform_fee          = parseFloat((platform_fee_order + platform_fee_delivery).toFixed(2))
    const chef_share            = parseFloat((subtotal * 0.83).toFixed(2))
    const driver_share          = isPickup ? 0 : parseFloat((delivery_fee * 0.90).toFixed(2))
    const total                 = parseFloat((subtotal + delivery_fee).toFixed(2))

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        customer_id,
        chef_id,
        delivery_address,
        delivery_lat,
        delivery_lng,
        subtotal,
        delivery_fee,
        platform_fee,
        chef_share,
        driver_share,
        total,
        payment_method,
        notes,
        status: 'pending',
        payment_status: 'pending'
      })
      .select()
      .single()

    if (orderErr) throw orderErr

    const itemsWithOrder = orderItems.map(i => ({ ...i, order_id: order.id }))
    const { error: itemsErr } = await supabase.from('order_items').insert(itemsWithOrder)
    if (itemsErr) throw itemsErr

    const { data: chef } = await supabase
      .from('chefs')
      .select('user_id')
      .eq('id', chef_id)
      .single()

    if (chef) {
      await supabase.from('notifications').insert({
        user_id: chef.user_id,
        title: 'ط·ظ„ط¨ ط¬ط¯ظٹط¯',
        body: `ظˆطµظ„ظƒ ط·ظ„ط¨ ط¬ط¯ظٹط¯ ط¨ظ‚ظٹظ…ط© ${total} ط±ظٹط§ظ„`,
        type: 'order_new',
        data: { order_id: order.id }
      })
    }

    res.status(201).json({ success: true, data: { ...order, items: orderItems } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
//  GET /orders/customer/:id
// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
router.get('/customer/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`*, order_items(*), chefs(*, users(full_name, gender))`)
      .eq('customer_id', req.params.id)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
//  GET /orders/chef/:id
// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
router.get('/chef/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`*, order_items(*), users(full_name, phone)`)
      .eq('chef_id', req.params.id)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
//  GET /orders?status=ready
// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
router.get('/', async (req, res) => {
  try {
    const { status } = req.query
    let query = supabase
      .from('orders')
      .select(`*, order_items(*), users(full_name, phone)`)
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
//  GET /orders/:id
// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select(`*, order_items(*), users(full_name, phone), chefs(*, users(full_name, gender, phone))`)
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
//  PATCH /orders/:id/status
// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    const validStatuses = ['accepted','preparing','ready','delivering','delivered','cancelled']

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'ط­ط§ظ„ط© ط؛ظٹط± طµط­ظٹط­ط©' })
    }

    const updates = { status }
    if (status === 'accepted')  updates.accepted_at  = new Date()
    if (status === 'ready')     updates.ready_at     = new Date()
    if (status === 'delivered') updates.delivered_at = new Date()

    const { data: order, error } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .select('*, customer_id, delivery_address, driver_id')
      .single()

    if (error) throw error

    // â”پâ”پâ”پ ظ…ظ†ط·ظ‚ طھط¹ظٹظٹظ† ط§ظ„ظ…ظ†ط¯ظˆط¨ ط¹ظ†ط¯ ready â”پâ”پâ”پ
    if (status === 'ready' && order.delivery_address !== 'ط§ط³طھظ„ط§ظ… ط´ط®طµظٹ') {
      const { data: availableDrivers } = await supabase
        .from('drivers')
        .select('id, user_id')
        .eq('is_available', true)

      if (availableDrivers && availableDrivers.length > 0) {
        const driverNotifications = availableDrivers.map(driver => ({
          user_id: driver.user_id,
          title: 'ط·ظ„ط¨ طھظˆطµظٹظ„ ط¬ط¯ظٹط¯',
          body: 'ظٹظˆط¬ط¯ ط·ظ„ط¨ ط¨ط§ظ†طھط¸ط§ط± ظ…ظ†ط¯ظˆط¨ â€” ط§ط¶ط؛ط· ظ„ظ‚ط¨ظˆظ„ظ‡',
          type: 'delivery_request',
          data: { order_id: order.id }
        }))
        await supabase.from('notifications').insert(driverNotifications)
      }

      // ط¨ط¹ط¯ ط¯ظ‚ظٹظ‚ط© â€” ط¥ط°ط§ ظ…ط§ ظپظٹ ظ…ظ†ط¯ظˆط¨ ظ‚ط¨ظ„
      setTimeout(async () => {
        const { data: currentOrder } = await supabase
          .from('orders')
          .select('id, driver_id, status, customer_id')
          .eq('id', order.id)
          .single()

        if (currentOrder && !currentOrder.driver_id && currentOrder.status === 'ready') {
          await supabase.from('notifications').insert({
            user_id: currentOrder.customer_id,
            title: 'ظ„ط§ ظٹظˆط¬ط¯ ظ…ظ†ط¯ظˆط¨ ظ…طھط§ط­',
            body: 'ظ„ط§ ظٹظˆط¬ط¯ ظ…ظ†ط¯ظˆط¨ ظ…طھط§ط­ ط­ط§ظ„ظٹط§ظ‹طŒ ظ‡ظ„ طھط±ظٹط¯ ط§ظ„ط§ظ†طھط¸ط§ط± ط£ظˆ ط§ظ„ط§ط³طھظ„ط§ظ… ط§ظ„ط´ط®طµظٹطں',
            type: 'no_driver_available',
            data: { order_id: order.id, options: ['wait', 'pickup'] }
          })
        }
      }, 60 * 1000)
    }

    // â”پâ”پâ”پ ط¥ط´ط¹ط§ط± ط§ظ„ط¹ظ…ظٹظ„ â”پâ”پâ”پ
    const statusMessages = {
      accepted:   { title: 'طھظ… ظ‚ط¨ظˆظ„ ط·ظ„ط¨ظƒ',    body: 'ط§ظ„ط´ظٹظپط© ظ‚ط¨ظ„طھ ط·ظ„ط¨ظƒ ظˆط¨ط¯ط£طھ ط§ظ„طھط­ط¶ظٹط±', type: 'order_accepted'   },
      preparing:  { title: 'ط·ظ„ط¨ظƒ ظٹظڈط­ط¶ظژظ‘ط±',     body: 'ط§ظ„ط´ظٹظپط© طھط­ط¶ط± ظˆط¬ط¨طھظƒ ط§ظ„ط¢ظ†',         type: 'order_preparing'  },
      ready:      { title: 'ط·ظ„ط¨ظƒ ط¬ط§ظ‡ط²',        body: 'ط·ظ„ط¨ظƒ ط¬ط§ظ‡ط² ظ„ظ„ط§ط³طھظ„ط§ظ… ط£ظˆ ط§ظ„طھظˆطµظٹظ„',  type: 'order_ready'      },
      delivering: { title: 'ظپظٹ ط§ظ„ط·ط±ظٹظ‚',        body: 'ط§ظ„ظ…ظ†ط¯ظˆط¨ طھظˆط¬ظ‡ ط¨ط·ظ„ط¨ظƒ',              type: 'order_delivering' },
      delivered:  { title: 'ظˆطµظ„ ط·ظ„ط¨ظƒ',         body: 'ط§ط³طھظ…طھط¹ ط¨ظˆط¬ط¨طھظƒ! ظ„ط§ طھظ†ط³ظ‰ ط§ظ„طھظ‚ظٹظٹظ…', type: 'order_delivered'  },
      cancelled:  { title: 'طھظ… ط¥ظ„ط؛ط§ط، ط§ظ„ط·ظ„ط¨',  body: 'طھظ… ط¥ظ„ط؛ط§ط، ط·ظ„ط¨ظƒ',                  type: 'order_cancelled'  }
    }

    if (statusMessages[status]) {
      await supabase.from('notifications').insert({
        user_id: order.customer_id,
        title: statusMessages[status].title,
        body: statusMessages[status].body,
        type: statusMessages[status].type,
        data: { order_id: order.id }
      })
    }

    res.json({ success: true, data: order })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
//  POST /orders/:id/review
// â”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پâ”پ
router.post('/:id/review', async (req, res) => {
  try {
    const order_id = req.params.id
    const { customer_id, rating, comment } = req.body
    const numericRating = Number(rating)

    if (!customer_id) {
      return res.status(400).json({ success: false, message: 'ظ…ط¹ط±ظپ ط§ظ„ط¹ظ…ظٹظ„ ظ…ط·ظ„ظˆط¨' })
    }

    if (!numericRating || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ success: false, message: 'ط§ظ„طھظ‚ظٹظٹظ… ظٹط¬ط¨ ط£ظ† ظٹظƒظˆظ† ط¨ظٹظ† 1 ظˆ 5' })
    }

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, chef_id, customer_id, status')
      .eq('id', order_id)
      .single()

    if (orderErr) throw orderErr

    if (order.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'ظ„ط§ ظٹظ…ظƒظ† ط§ظ„طھظ‚ظٹظٹظ… ط¥ظ„ط§ ط¨ط¹ط¯ ط§ظ„طھط³ظ„ظٹظ…' })
    }

    if (String(order.customer_id) !== String(customer_id)) {
      return res.status(403).json({ success: false, message: 'ط؛ظٹط± ظ…طµط±ط­' })
    }

    const { data: existingReview } = await supabase
      .from('reviews')
      .select('id')
      .eq('order_id', order_id)
      .maybeSingle()

    if (existingReview) {
      return res.status(409).json({ success: false, message: 'طھظ… طھظ‚ظٹظٹظ… ظ‡ط°ط§ ط§ظ„ط·ظ„ط¨ ظ…ط³ط¨ظ‚ط§ظ‹' })
    }

    const { data: review, error: reviewErr } = await supabase
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

    res.status(201).json({ success: true, data: review })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router
