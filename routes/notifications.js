const express = require('express')
const { requireUser, assertSelf } = require('../auth')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /notifications/:user_id — كل إشعارات المستخدم (الأحدث أول)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/:user_id', requireUser, async (req, res) => {
  if (!assertSelf(req, res, req.params.user_id)) return

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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

module.exports = router