const express  = require('express')
const router   = express.Router()
const supabase = require('../supabase')

// ━━━ GET /menu/chef/:chef_id — كل وجبات الشيف ━━━
router.get('/chef/:chef_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('menu_items')
      .select('*')
      .eq('chef_id', req.params.chef_id)
      .order('category')
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━ POST /menu — إضافة وجبة ━━━
router.post('/', async (req, res) => {
  try {
    const { chef_id, name, price, category, status, prep_hours, prep_minutes, description, is_available, image_url } = req.body
console.log("BODY IMAGE:", image_url)
    if (!chef_id || !name || !price)
      return res.status(400).json({ success: false, message: 'chef_id والاسم والسعر مطلوبان' })

    const { data, error } = await supabase
      .from('menu_items')
      .insert({
        chef_id, name, price,
        category:    category || 'rice',
        status:      status || 'available',
        prep_hours:  prep_hours || 0,
        description: description || '',
        image_url:    image_url || null,
        prep_minutes: prep_minutes || 0,
        is_available: status === 'available',
      })
      .select().single()
    if (error) throw error
    res.status(201).json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━ PATCH /menu/:id — تعديل وجبة ━━━
router.patch('/:id', async (req, res) => {
  try {
    const { name, price, category, status, prep_hours, prep_minutes, description, is_available, image_url } = req.body
    console.log("PATCH BODY:", JSON.stringify(req.body))
    const updates = {}
    if (name)                          updates.name         = name
    if (price)                         updates.price        = price
    if (category)                      updates.category     = category
    if (status)                        updates.status       = status
    if (typeof prep_hours   !== 'undefined') updates.prep_hours   = Number(prep_hours ?? 0)
    if (typeof prep_minutes !== 'undefined') updates.prep_minutes = Number(prep_minutes ?? 0)
    if (typeof image_url !== 'undefined') updates.image_url = image_url || null
    if (description !== undefined)     updates.description  = description
    if (typeof is_available !== 'undefined') {
      updates.is_available = is_available
    } else if (status) {
      updates.is_available = status === 'available'
    }

    const { data, error } = await supabase
      .from('menu_items').update(updates).eq('id', req.params.id).select().single()
    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ━━━ DELETE /menu/:id — حذف وجبة ━━━
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('menu_items').delete().eq('id', req.params.id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router

