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
  'bank_transfer_iban',    // آيبان المنصة — يظهر للعميل عند اختيار التحويل البنكي
  'bank_transfer_name',    // اسم صاحب الحساب — البنوك ترفض التحويل إن لم يطابق
  'delivery_enabled',      // "true" يُظهر خيار التوصيل وتسجيل المناديب — غيابه أو أي قيمة أخرى = استلام فقط
  'online_payments_enabled', // "true" يُظهر مدى/Apple Pay في التطبيق — يُشغَّل بعد جهوزية البوابة وPAYMENT_GATEWAY في Railway
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
    res.status(500).json({ success: false, message: 'تعذر إتمام العملية — حاول مرة ثانية' })
  }
})

module.exports = router