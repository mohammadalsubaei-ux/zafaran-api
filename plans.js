// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  زعفران — باقات الظهور المدفوع
//
//  قرارات محسومة تحمي العميل وتحمي المتجر من إحراق ميزانيته:
//   1) تعليق تلقائي إن نزل التقييم تحت 4.5 — سمعتك تُبنى على أسوأ متجر دفع
//   2) تُباع بالظهورات لا بالمدة — المتجر الضعيف يحرقها بلا طلبات ويتوقف بنفسه
//   3) لا تُباع لمتجر تحت 50 طلباً — يثبت نفسه أولاً
//
//  والبيع خارج التطبيق تماماً: واتساب ثم تحويل ثم تفعيل يدوي من لوحة الأدمن
//  (بيعها داخل iOS يدخل في المشتريات داخل التطبيق: عمولة 30% أو رفض).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MIN_RATING_TO_STAY   = 4.5
const MIN_ORDERS_TO_BUY    = 50

// هل الباقة صالحة للعرض الآن؟
function isPlanLive(plan, chef) {
  if (!plan || !plan.is_active || plan.is_suspended) return false
  if (plan.ends_at && new Date(plan.ends_at) < new Date()) return false

  // نفدت الظهورات
  if (Number(plan.impressions_used) >= Number(plan.impressions_total)) return false

  // التقييم نزل — تعليق تلقائي، والشرط معلن قبل الشراء
  if (Number(chef?.rating_avg || 0) < MIN_RATING_TO_STAY) return false

  return true
}

// سبب عدم الظهور — للعرض في لوحة المتجر بدل صمت محيّر
function planStatus(plan, chef) {
  if (!plan) return { state: 'none', message: 'لا توجد باقة نشطة' }

  if (!plan.is_active) return { state: 'inactive', message: 'الباقة منتهية' }

  if (plan.is_suspended) {
    return { state: 'suspended', message: plan.suspended_reason || 'الباقة معلّقة' }
  }

  if (plan.ends_at && new Date(plan.ends_at) < new Date()) {
    return { state: 'expired', message: 'انتهت مدة الباقة' }
  }

  if (Number(plan.impressions_used) >= Number(plan.impressions_total)) {
    return { state: 'used_up', message: 'نفدت ظهورات الباقة' }
  }

  if (Number(chef?.rating_avg || 0) < MIN_RATING_TO_STAY) {
    return {
      state: 'paused_rating',
      message: `الظهور متوقف مؤقتاً — التقييم أقل من ${MIN_RATING_TO_STAY}. يعود تلقائياً عند التحسّن.`
    }
  }

  const left = Number(plan.impressions_total) - Number(plan.impressions_used)
  return { state: 'live', message: `باقة نشطة — باقٍ ${left} ظهور` }
}

// هل يحق للمتجر شراء باقة؟ (يُستخدم في لوحة الأدمن قبل التفعيل)
function canBuyPlan(chef) {
  const orders = Number(chef?.total_orders || 0)

  if (orders < MIN_ORDERS_TO_BUY) {
    return {
      allowed: false,
      reason: `يلزم ${MIN_ORDERS_TO_BUY} طلباً على الأقل قبل شراء باقة (الحالي: ${orders})`
    }
  }

  return { allowed: true, reason: null }
}

module.exports = {
  MIN_RATING_TO_STAY,
  MIN_ORDERS_TO_BUY,
  isPlanLive,
  planStatus,
  canBuyPlan,
}
