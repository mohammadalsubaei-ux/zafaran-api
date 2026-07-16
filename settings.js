const supabase = require('./supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  إعدادات المنصة — المصدر الوحيد لكل النِّسب والرسوم
//  تُقرأ من جدول app_settings لحظياً (تعديل الأدمن يسري على الطلب التالي فوراً)
//
//  القيم الاحتياطية أدناه تضمن استمرار العمل حتى لو تعذر الوصول للجدول
//  الاستخدام: const getSettings = require('../settings')
//             const s = await getSettings()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULTS = {
  platform_commission_rate: 0.17, // عمولة زعفران من قيمة الطلب
  delivery_platform_rate:   0.10, // نسبة زعفران من رسوم التوصيل (تقرب للأعلى)
  delivery_base_fee:        10,   // رسوم التوصيل الأساسية (ريال)
  delivery_base_km:         4.99, // المسافة المشمولة بالرسوم الأساسية (كم)
  delivery_per_km_fee:      1,    // رسوم كل كيلومتر إضافي (ريال)
  min_withdrawal_amount:    200,  // الحد الأدنى لسحب أرباح الشيف (ريال)
}

async function getSettings() {
  try {
    const { data, error } = await supabase.from('app_settings').select('key, value')
    if (error || !data) return { ...DEFAULTS }

    const settings = { ...DEFAULTS }
    for (const row of data) {
      const num = parseFloat(row.value)
      if (isFinite(num) && num >= 0) settings[row.key] = num
    }
    return settings
  } catch (err) {
    console.error('getSettings failed, using defaults:', err.message)
    return { ...DEFAULTS }
  }
}

module.exports = getSettings