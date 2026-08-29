// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  زعفران — مستويات المتاجر
//
//  وسام على الأداء، لا يُباع ولا يؤثر على الترتيب.
//  (التقييم وعدد الطلبات مؤثران أصلاً في معادلة الترتيب،
//   وإضافتهما مرة ثانية عبر المستوى مضاعفة غير عادلة.)
//
//  الشرط مبني على ما تملكه القاعدة فعلاً: rating_avg و total_orders.
//  نسبة الإلغاء غير مخزّنة، فلم تُدرج بدل أن تُخترع.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TIERS = [
  { id: 'diamond',  label: 'ألماسي',  minRating: 4.8, minOrders: 500, color: '#7FD8E8' },
  { id: 'platinum', label: 'بلاتيني', minRating: 4.6, minOrders: 200, color: '#C9C9D4' },
  { id: 'gold',     label: 'ذهبي',    minRating: 4.3, minOrders: 50,  color: '#F2B233' },
  { id: 'silver',   label: 'فضي',     minRating: 0,   minOrders: 0,   color: '#A8A8A8' },
]

// المستوى الحالي — يُرتَّب من الأعلى فأول تطابق هو الصحيح
function tierOf(chef) {
  const rating = Number(chef?.rating_avg || 0)
  const orders = Number(chef?.total_orders || 0)

  const tier = TIERS.find(t => rating >= t.minRating && orders >= t.minOrders) || TIERS[TIERS.length - 1]
  const index = TIERS.indexOf(tier)

  // المستوى التالي (أعلى في القائمة = فهرس أقل)
  const next = index > 0 ? TIERS[index - 1] : null

  let progress = null
  if (next) {
    const ordersLeft = Math.max(next.minOrders - orders, 0)
    const ratingGap  = Math.max(next.minRating - rating, 0)

    progress = {
      next_id: next.id,
      next_label: next.label,
      orders_left: ordersLeft,
      rating_needed: next.minRating,
      rating_gap: Math.round(ratingGap * 100) / 100,
      // نسبة تقدّم تقريبية بعدد الطلبات — للعرض في شريط التقدّم
      percent: next.minOrders > 0
        ? Math.min(Math.round((orders / next.minOrders) * 100), 99)
        : 0
    }
  }

  return {
    id: tier.id,
    label: tier.label,
    color: tier.color,
    // الشارة تظهر للعميل من الذهبي فأعلى — الفضي هو الوضع الافتراضي
    show_badge: tier.id !== 'silver',
    progress
  }
}

module.exports = { TIERS, tierOf }
