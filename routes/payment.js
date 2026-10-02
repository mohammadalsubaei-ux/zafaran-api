const express = require('express')
const { requireUser } = require('../auth')
const router = express.Router()
const supabase = require('../supabase')
const gateway = require('../gateway')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  الدفع الإلكتروني عبر صفحة مستضافة — انظر gateway.js
//
//  التدفق:
//    1. التطبيق ينشئ الطلب (payment_status = pending)
//    2. POST /api/payment/create { order_id }  → { url }   يفتحه التطبيق في المتصفح الداخلي
//    3. البوابة تعيد المستخدم إلى GET /api/payment/return → يعود للتطبيق
//    4. GET /api/payment/status/:order_id → الخادم يتحقق عند البوابة بالمفتاح السري
//       ويعلّم الطلب مدفوعاً. التطبيق لا يستطيع تعليم أي طلب مدفوعاً بنفسه.
//
//  لا يوجد أي مسار "محاكاة" — إن كانت البوابة مطفأة يُرجع 503 والتطبيق يخفي الخيار.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ONLINE_METHODS = ['card', 'apple_pay', 'stc_pay']
const APP_SCHEME     = process.env.APP_SCHEME || 'zafaranapp'

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https'
  return `${proto}://${req.get('host')}`
}

async function loadOwnOrder(req, res, orderId) {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, total, payment_status, payment_method, payment_transaction_id, customer_id')
    .eq('id', orderId)
    .maybeSingle()

  if (error) throw error
  if (!order) { res.status(404).json({ success: false, message: 'الطلب غير موجود' }); return null }

  // بلا هذا الفحص يدفع (أو يستعلم عن) أي شخص طلب غيره
  if (String(order.customer_id) !== String(req.userId)) {
    res.status(403).json({ success: false, message: 'غير مصرح — هذا الطلب ليس لك' })
    return null
  }
  return order
}

// ━━ POST /api/payment/create — ينشئ عملية عند البوابة ويرجع رابط الدفع ━━
router.post('/create', requireUser, async (req, res) => {
  try {
    if (!gateway.enabled) {
      return res.status(503).json({ success: false, message: 'الدفع الإلكتروني غير متاح حالياً — اختر الدفع عند الاستلام أو التحويل' })
    }

    const orderId = String(req.body?.order_id || '').trim()
    if (!orderId) return res.status(400).json({ success: false, message: 'order_id مطلوب' })

    const order = await loadOwnOrder(req, res, orderId)
    if (!order) return

    if (order.payment_status === 'paid') {
      return res.status(409).json({ success: false, message: 'تم دفع هذا الطلب مسبقاً' })
    }
    if (!ONLINE_METHODS.includes(order.payment_method)) {
      return res.status(400).json({ success: false, message: 'هذا الطلب ليس بالدفع الإلكتروني' })
    }

    const returnUrl = `${baseUrl(req)}/api/payment/return?order=${encodeURIComponent(orderId)}`
    const { url, ref } = await gateway.createPayment({ order, returnUrl })

    if (!url) throw new Error('gateway returned no url')

    // نحفظ معرّف العملية الآن — يُستخدم في التحقق لاحقاً
    const { error: updErr } = await supabase
      .from('orders')
      .update({ payment_transaction_id: ref || null, payment_status: 'pending' })
      .eq('id', orderId)
    if (updErr) throw updErr

    res.json({ success: true, data: { url } })
  } catch (err) {
    console.error('[payment/create]', err.message)
    res.status(500).json({ success: false, message: 'تعذر بدء عملية الدفع — حاول مرة ثانية' })
  }
})

// ━━ GET /api/payment/status/:order_id — يتحقق عند البوابة ويعلّم الطلب ━━
router.get('/status/:order_id', requireUser, async (req, res) => {
  try {
    const orderId = String(req.params.order_id || '').trim()
    const order = await loadOwnOrder(req, res, orderId)
    if (!order) return

    if (order.payment_status === 'paid') {
      return res.json({ success: true, data: { paid: true, transaction_id: order.payment_transaction_id } })
    }

    if (!gateway.enabled || !order.payment_transaction_id) {
      return res.json({ success: true, data: { paid: false } })
    }

    const result = await gateway.verifyPayment({ ref: order.payment_transaction_id, order })

    if (!result?.paid) {
      return res.json({ success: true, data: { paid: false } })
    }

    const { error: updErr } = await supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        payment_transaction_id: result.transaction_id || order.payment_transaction_id,
        paid_at: new Date().toISOString(),
      })
      .eq('id', orderId)
      .neq('payment_status', 'paid')
    if (updErr) throw updErr

    res.json({ success: true, data: { paid: true, transaction_id: result.transaction_id || order.payment_transaction_id } })
  } catch (err) {
    console.error('[payment/status]', err.message)
    res.status(500).json({ success: false, message: 'تعذر التحقق من الدفع — حاول مرة ثانية' })
  }
})

// ━━ GET /api/payment/return — صفحة العودة بعد الدفع: تعيد المستخدم للتطبيق ━━
// لا تعلّم شيئاً مدفوعاً — التحقق الحقيقي في /status بالمفتاح السري
router.get('/return', (req, res) => {
  const deepLink = `${APP_SCHEME}://payment-return`
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>زعفران</title>
<meta http-equiv="refresh" content="0;url=${deepLink}">
<style>body{font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:60px 24px;color:#333}a{color:#b8860b;font-weight:700}</style>
</head><body>
<p>جارٍ العودة إلى التطبيق…</p>
<p><a href="${deepLink}">اضغط هنا إن لم تُفتح الصفحة تلقائياً</a></p>
<script>setTimeout(function(){location.href=${JSON.stringify(deepLink)}},300)</script>
</body></html>`)
})

// ━━ POST /api/payment/process — المسار القديم (محاكاة) أُزيل ━━
// النسخ القديمة من التطبيق تستدعيه؛ نرد برسالة واضحة بدل 404
router.post('/process', requireUser, (req, res) => {
  res.status(410).json({ success: false, message: 'حدّث التطبيق لاستخدام الدفع الإلكتروني' })
})

module.exports = router
