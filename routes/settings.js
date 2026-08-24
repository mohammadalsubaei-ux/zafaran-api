const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GET /settings/:key — قراءة إعداد عام واحد بالاسم
//  عام بدون توكن، لكن محصور في قائمة بيضاء صريحة:
//  أي إعداد خارجها (نسب العمولة، حدود السحب) لا يُكشف للتطبيق
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// الإعدادات المسموح قراءتها علناً — أضف هنا فقط ما يحتاجه التطبيق للعرض
const PUBLIC_KEYS = [
  'latest_version',        // أحدث نسخة منشورة (1.0.2) — المصدر المعتمد لرسالة التحديث
  'latest_version_code',   // مهجور: versionCode مجمّد في app.json ولا يعكس نسخة EAS
  'update_required',       // هل التحديث إجباري (اختياري مستقبلاً)
]

router.get('/:key', async (req, res) => {
  try {
    const key = String(req.params.key || '').trim()

    if (!PUBLIC_KEYS.includes(key)) {
      return res.status(404).json({ success: false, message: 'إعداد غير متاح' })
    }

    const { data, error } = await supabase
      .from('app_settings')
      .select('key, value')
      .eq('key', key)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ success: false, message: 'الإعداد غير موجود' })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router