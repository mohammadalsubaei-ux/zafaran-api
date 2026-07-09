const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ⚠️ نقطة التبديل المستقبلية الوحيدة لـ Moyasar ⚠️
//
//  حالياً: محاكاة (Simulation) — تنجح فوراً بدون أي بوابة حقيقية.
//  مستقبلاً (بعد جهوزية السجل التجاري + حساب Moyasar):
//    استبدل محتوى دالة processPaymentWithGateway() فقط
//    باستدعاء API الحقيقي لـ Moyasar، وباقي الملف ما يتغيّر.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function processPaymentWithGateway({ orderId, paymentMethod, amount }) {
  // محاكاة تأخير معالجة حقيقي (تجربة مستخدم واقعية)
  await new Promise(resolve => setTimeout(resolve, 1200))

  // TODO (لما يجهز Moyasar): استبدل هذا بنداء API فعلي، وأرجع النتيجة الحقيقية
  return {
    success: true,
    transaction_id: `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    gateway: 'simulated'
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  POST /payment/process — معالجة دفع طلب معين
//  body: { order_id, payment_method }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/process', async (req, res) => {
  try {
    const { order_id, payment_method } = req.body

    if (!order_id || !payment_method) {
      return res.status(400).json({ success: false, message: 'order_id و payment_method مطلوبان' })
    }

    if (!['card', 'apple_pay', 'stc_pay'].includes(payment_method)) {
      return res.status(400).json({ success: false, message: 'وسيلة دفع غير مدعومة' })
    }

    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('id, total, payment_status, customer_id')
      .eq('id', order_id)
      .single()

    if (fetchErr) throw fetchErr

    if (order.payment_status === 'paid') {
      return res.status(409).json({ success: false, message: 'تم دفع هذا الطلب مسبقاً' })
    }

    const result = await processPaymentWithGateway({
      orderId: order_id,
      paymentMethod: payment_method,
      amount: order.total
    })

    if (!result.success) {
      return res.status(402).json({ success: false, message: 'فشلت عملية الدفع، حاول مرة أخرى' })
    }

    const { data: updatedOrder, error: updateErr } = await supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        payment_method,
        payment_transaction_id: result.transaction_id
      })
      .eq('id', order_id)
      .select()
      .single()

    if (updateErr) throw updateErr

    res.json({
      success: true,
      data: {
        order: updatedOrder,
        transaction_id: result.transaction_id
      }
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router