const express  = require('express')
const router   = express.Router()
const supabase = require('../supabase')

function calcDistance(lat1, lng1, lat2, lng2) {
  const R    = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a    = Math.sin(dLat/2) * Math.sin(dLat/2) +
               Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
               Math.sin(dLng/2) * Math.sin(dLng/2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

function calcDeliveryFee(distanceKm) {
  if (distanceKm <= 4.99) return 10
  const extraKm  = distanceKm - 5
  const extraFee = Math.ceil(extraKm) * 1
  return 10 + extraFee
}

function splitDeliveryFee(totalFee) {
  const zafaranShare = Math.ceil(totalFee * 0.10)
  const driverShare  = totalFee - zafaranShare
  return { zafaranShare, driverShare }
}

// GET /chefs/search?q=
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query
    if (!q) return res.json({ success: true, data: [] })

    const { data, error } = await supabase
      .from('menu_items')
      .select(`*, chefs (*, users ( full_name, avatar_url, phone, gender ))`)
      .ilike('name', `%${q}%`)
      .eq('status', 'available')

    if (error) throw error

    const chefsMap = new Map()
    data.forEach(item => {
      if (item.chefs && !chefsMap.has(item.chefs.id))
        chefsMap.set(item.chefs.id, item.chefs)
    })

    // نجيب المنيو لكل شيف
    const chefIds = Array.from(chefsMap.keys())
    if (chefIds.length > 0) {
      const { data: allMenu } = await supabase
        .from('menu_items')
        .select('*')
        .in('chef_id', chefIds)
        .eq('status', 'available')

      const menuByChef = {}
      ;(allMenu || []).forEach(m => {
        if (!menuByChef[m.chef_id]) menuByChef[m.chef_id] = []
        menuByChef[m.chef_id].push(m)
      })

      chefsMap.forEach((chef, id) => {
        chef.menu = menuByChef[id] || []
      })
    }

    res.json({ success: true, data: Array.from(chefsMap.values()) })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// GET /chefs
router.get('/', async (req, res) => {
  try {
    const { city, user_id, gender, category, lat, lng } = req.query

    let query = supabase
      .from('chefs')
      .select(`*, users ( full_name, avatar_url, phone, gender )`)

    if (!user_id) query = query.eq('is_verified', true)
    if (city)     query = query.eq('city', city)
    if (user_id)  query = query.eq('user_id', user_id)

    // فلاتر الميزات الخاصة
    const { featured, type } = req.query
    if (type === 'buffet')      query = query.eq('offers_buffet', true)
    if (type === 'hospitality') query = query.eq('offers_hospitality', true)
    if (type === 'daily')       query = query.eq('offers_daily', true)

    const { data: chefsRaw, error } = await query.order('rating_avg', { ascending: false })
    if (error) throw error

    let chefs = gender ? chefsRaw.filter(c => c.users?.gender === gender) : chefsRaw

    // فلتر الموقع
    if (lat && lng) {
      chefs = chefs
        .map(chef => {
          if (!chef.lat || !chef.lng) return chef
          const dist = calcDistance(parseFloat(lat), parseFloat(lng), chef.lat, chef.lng)
          if (dist > (chef.max_delivery_km || 10)) return null
          const fee   = calcDeliveryFee(dist)
          const split = splitDeliveryFee(fee)
          return {
            ...chef,
            distance_km: parseFloat(dist.toFixed(2)),
            delivery_fee: fee,
            driver_share: split.driverShare,
            zafaran_share: split.zafaranShare,
          }
        })
        .filter(Boolean)
        .sort((a, b) => (a.distance_km || 0) - (b.distance_km || 0))
    }

    // جلب المنيو لكل الشيفات (دفعة واحدة، أداء أفضل)
    const chefIds = chefs.map(c => c.id)
    if (chefIds.length > 0) {
      const { data: allMenu } = await supabase
        .from('menu_items')
        .select('*')
        .in('chef_id', chefIds)
        .eq('status', 'available')

      const menuByChef = {}
      ;(allMenu || []).forEach(m => {
        if (!menuByChef[m.chef_id]) menuByChef[m.chef_id] = []
        menuByChef[m.chef_id].push(m)
      })

      chefs = chefs.map(c => ({ ...c, menu: menuByChef[c.id] || [] }))
    }

    // فلتر التصنيف (يطبق بعد جلب المنيو)
    if (category && category !== 'all') {
      chefs = chefs.filter(c =>
        c.menu && c.menu.some(m => m.category === category)
      )
    }

    // ترتيب حسب النوع
    if (type === 'popular') {
      chefs = chefs.sort((a, b) => (b.total_orders || 0) - (a.total_orders || 0))
    }
    if (type === 'new') {
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      chefs = chefs.filter(c => new Date(c.created_at) > thirtyDaysAgo)
    }

    res.json({ success: true, data: chefs })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// GET /chefs/:id
router.get('/:id', async (req, res) => {
  try {
    const { data: chef, error: chefErr } = await supabase
      .from('chefs')
      .select(`*, users ( full_name, avatar_url, gender )`)
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

// PATCH /chefs/:id/toggle
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { is_open } = req.body
    const updates = {}
    if (typeof is_open !== 'undefined') updates.is_open = is_open

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

// GET /chefs/:id/delivery-fee?lat=&lng=
router.get('/:id/delivery-fee', async (req, res) => {
  try {
    const { lat, lng } = req.query
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat و lng مطلوبان' })
    }

    const { data: chef, error } = await supabase
      .from('chefs')
      .select('lat, lng, max_delivery_km')
      .eq('id', req.params.id)
      .single()
    if (error) throw error
    if (!chef.lat || !chef.lng) {
      return res.status(400).json({ success: false, message: 'موقع الشيف غير محدد' })
    }

    const dist = calcDistance(parseFloat(lat), parseFloat(lng), chef.lat, chef.lng)
    if (dist > (chef.max_delivery_km || 10)) {
      return res.status(400).json({ success: false, message: 'خارج نطاق التوصيل' })
    }

    const fee   = calcDeliveryFee(dist)
    const split = splitDeliveryFee(fee)
    res.json({
      success: true,
      data: {
        distance_km: parseFloat(dist.toFixed(2)),
        delivery_fee: fee,
        driver_share: split.driverShare,
        zafaran_share: split.zafaranShare,
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router