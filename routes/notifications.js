const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /notifications/:user_id — كل إشعارات المستخدم (الأحدث أول)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:user_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.params.user_id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router