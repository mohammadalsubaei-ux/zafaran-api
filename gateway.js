// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  gateway.js — نقطة التبديل الوحيدة لبوابة الدفع
//
//  التطبيق لا يعرف من هي البوابة. يطلب رابطاً من الباك إند ويفتحه،
//  ثم يسأل الباك إند: هل دُفع؟ تبديل البوابة = ملف محوّل واحد + متغير Railway.
//
//  متغير Railway:  PAYMENT_GATEWAY = paylink | moyasar | (فارغ = الدفع الإلكتروني مطفأ)
//
//  عقد المحوّل (ملف gateways/<name>.js يصدّر دالتين):
//    createPayment({ order, returnUrl }) → { url, ref }
//        url: صفحة الدفع التي يفتحها التطبيق · ref: معرّف العملية عند البوابة
//    verifyPayment({ ref, order })      → { paid, transaction_id }
//        يُستدعى بالمفتاح السري من الخادم فقط — لا يُصدَّق أي شيء يأتي من التطبيق
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const NAME = String(process.env.PAYMENT_GATEWAY || '').trim().toLowerCase()

let gateway = null

if (NAME) {
  try {
    gateway = require(`./gateways/${NAME}`)
    if (typeof gateway.createPayment !== 'function' || typeof gateway.verifyPayment !== 'function') {
      console.error(`[gateway] gateways/${NAME}.js لا يصدّر createPayment/verifyPayment — الدفع الإلكتروني مطفأ`)
      gateway = null
    } else {
      console.log(`[gateway] بوابة الدفع: ${NAME}`)
    }
  } catch (err) {
    console.error(`[gateway] تعذر تحميل gateways/${NAME}.js — الدفع الإلكتروني مطفأ:`, err.message)
    gateway = null
  }
} else {
  console.log('[gateway] PAYMENT_GATEWAY غير مضبوط — الدفع الإلكتروني مطفأ (كاش وتحويل فقط)')
}

module.exports = {
  name: gateway ? NAME : null,
  enabled: Boolean(gateway),
  createPayment: (args) => gateway.createPayment(args),
  verifyPayment: (args) => gateway.verifyPayment(args),
}
