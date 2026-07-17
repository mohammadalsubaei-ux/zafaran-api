const express = require('express')
const router  = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /api/banners — البانرات المفعلة للصفحة الرئيسية
//  (عام بدون توكن — محتوى تسويقي تتحكم به لوحة الأدمن)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('banners')
      .select('id, title, subtitle, bg_color, text_color, target')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    if (error) throw error
    res.json({ success: true, data: data || [] })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router