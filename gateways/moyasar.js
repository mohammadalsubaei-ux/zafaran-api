// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  محوّل ميسر (Moyasar) — فواتير مستضافة (Invoices API)
//
//  متغيرات Railway:
//    PAYMENT_GATEWAY     = moyasar
//    MOYASAR_SECRET_KEY  = sk_test_... (تجريبي) أو sk_live_... (حقيقي)
//
//  صفحة الفاتورة عند ميسر تعرض مدى/فيزا/ماستركارد وApple Pay وSTC Pay
//  حسب ما هو مفعّل في حسابك لديهم. التطبيق يفتحها ثم يعود ويسأل الخادم.
//
//  التحقق (verifyPayment) يتم بالمفتاح السري من الخادم فقط، ويشترط:
//    الحالة paid + المبلغ بالهللات = إجمالي الطلب + العملة SAR + (إن وُجد) رقم الطلب في metadata
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const API_BASE = process.env.MOYASAR_API_BASE || 'https://api.moyasar.com/v1'
const TIMEOUT_MS = 15000

function secretKey() {
  const key = String(process.env.MOYASAR_SECRET_KEY || '').trim()
  if (!key) throw new Error('MOYASAR_SECRET_KEY is not set')
  return key
}

function authHeader() {
  // ميسر: Basic auth — المفتاح السري اسم مستخدم وكلمة المرور فارغة
  return 'Basic ' + Buffer.from(secretKey() + ':').toString('base64')
}

// الريال → هللات (عدد صحيح) — ميسر يتعامل بأصغر وحدة
function toHalalas(total) {
  return Math.round(Number(total) * 100)
}

async function call(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    // لا نسجّل المفتاح أبداً — فقط الحالة ورسالة ميسر
    const msg = json?.message || json?.type || 'request failed'
    throw new Error(`moyasar ${method} ${path} → ${res.status}: ${msg}`)
  }
  return json
}

async function createPayment({ order, returnUrl }) {
  const amount = toHalalas(order.total)
  if (!Number.isInteger(amount) || amount < 100) {
    throw new Error('order total below the gateway minimum (1 SAR)')
  }

  const invoice = await call('POST', '/invoices', {
    amount,
    currency: 'SAR',
    description: `طلب زعفران #${String(order.id).slice(0, 8)}`,
    success_url: returnUrl,
    back_url: returnUrl,
    metadata: { order_id: String(order.id) },
  })

  if (!invoice?.id || !invoice?.url) throw new Error('moyasar returned no invoice url')
  return { url: invoice.url, ref: invoice.id }
}

async function verifyPayment({ ref, order }) {
  if (!ref) return { paid: false }

  const invoice = await call('GET', `/invoices/${encodeURIComponent(ref)}`)

  if (String(invoice?.status || '').toLowerCase() !== 'paid') return { paid: false }

  // الفاتورة المدفوعة يجب أن تطابق هذا الطلب بالضبط — لا نثق بمجرد "paid"
  const expected = toHalalas(order.total)
  if (Number(invoice.amount) !== expected) {
    console.error('[moyasar] amount mismatch', { invoice: invoice.id, got: invoice.amount, expected })
    return { paid: false }
  }
  if (String(invoice.currency || '').toUpperCase() !== 'SAR') {
    console.error('[moyasar] currency mismatch', { invoice: invoice.id, currency: invoice.currency })
    return { paid: false }
  }
  const metaOrder = invoice.metadata?.order_id
  if (metaOrder && String(metaOrder) !== String(order.id)) {
    console.error('[moyasar] order mismatch', { invoice: invoice.id, metaOrder, order: order.id })
    return { paid: false }
  }

  // نبقي معرّف الفاتورة مرجعاً (يمكن البحث عنه في لوحة ميسر، ومنه الوصول لعملية الدفع)
  return { paid: true, transaction_id: invoice.id }
}

module.exports = { createPayment, verifyPayment }
