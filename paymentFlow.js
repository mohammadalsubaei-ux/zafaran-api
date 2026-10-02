// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  دورة الطلب المدفوع إلكترونياً
//
//  الطلب الفوري بالدفع الإلكتروني لا يصل للمتجر إلا بعد تأكيد الدفع:
//    - لا إشعار للشيف عند الإنشاء، ولا يظهر في لوحته، ولا يستطيع قبوله
//    - عند تأكيد الدفع (من التطبيق أو من المراجعة الدورية) يصل الإشعار للشيف
//    - إن لم يُدفع خلال PAYMENT_WINDOW_MIN دقيقة يُلغى تلقائياً
//
//  المراجعة الدورية تسأل البوابة أيضاً عن الطلبات المعلّقة، فتؤكد الدفع
//  حتى لو أغلق العميل التطبيق قبل العودة من صفحة الدفع.
//
//  الطلب المسبق مستثنى: يتفاوض الشيف والعميل على الوقت أولاً ثم يُدفع.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const supabase = require('./supabase')
const notifyUser = require('./notify')
const gateway = require('./gateway')
const { applyStatusChange } = require('./orderStatus')

const ONLINE_METHODS = ['card', 'apple_pay', 'stc_pay']
const PAYMENT_WINDOW_MIN = Number(process.env.PAYMENT_WINDOW_MIN || 15)
const SWEEP_EVERY_MS = 60 * 1000

function isOnline(order) {
  return ONLINE_METHODS.includes(String(order?.payment_method || ''))
}

// طلب فوري إلكتروني لم يُدفع بعد — مخفي عن المتجر
function isAwaitingPayment(order) {
  return !!order && order.order_type !== 'preorder' && isOnline(order) && order.payment_status !== 'paid'
}

async function notifyChefOfPaidOrder(order) {
  const { data: chef } = await supabase
    .from('chefs')
    .select('user_id')
    .eq('id', order.chef_id)
    .maybeSingle()
  if (!chef?.user_id) return

  const preorder = order.order_type === 'preorder'
  await notifyUser(
    chef.user_id,
    preorder ? 'تم دفع الطلب المسبق' : 'طلب جديد (مدفوع)',
    preorder
      ? 'العميل دفع قيمة الطلب المسبق — جهّزه في الموعد المتفق عليه'
      : `وصلك طلب جديد مدفوع إلكترونياً بقيمة ${order.total} ريال`,
    preorder ? 'preorder_paid' : 'order_new',
    { order_id: order.id }
  )
}

// يعلّم الطلب مدفوعاً (مرة واحدة فقط) ويُشعر المتجر. يرجع true إن كان هذا النداء هو من أكّد الدفع.
async function markPaid(order, transactionId) {
  const { data: rows, error } = await supabase
    .from('orders')
    .update({
      payment_status: 'paid',
      payment_transaction_id: transactionId || order.payment_transaction_id,
      paid_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .neq('payment_status', 'paid')
    .neq('status', 'cancelled')
    .select('id, chef_id, total, order_type')
  if (error) throw error
  if (!rows || rows.length === 0) return false

  await notifyChefOfPaidOrder(rows[0]).catch(err =>
    console.error('[payment] chef notify failed', order.id, err.message))
  return true
}

// ━━ المراجعة الدورية ━━
async function sweep() {
  const cutoff = new Date(Date.now() - PAYMENT_WINDOW_MIN * 60 * 1000)

  const { data: pending, error } = await supabase
    .from('orders')
    .select('id, status, customer_id, chef_id, driver_id, delivery_address, total, order_type, payment_method, payment_status, payment_transaction_id, created_at')
    .eq('status', 'pending')
    .in('payment_method', ONLINE_METHODS)
    .neq('payment_status', 'paid')
    .order('created_at', { ascending: true })
    .limit(50)
  if (error) throw error

  for (const order of pending || []) {
    if (order.order_type === 'preorder') continue

    try {
      // أولاً: ربما دفع العميل ولم يرجع للتطبيق
      if (gateway.enabled && order.payment_transaction_id) {
        const result = await gateway.verifyPayment({ ref: order.payment_transaction_id, order })
        if (result?.paid) {
          await markPaid(order, result.transaction_id)
          continue
        }
      }

      // انتهت المهلة بلا دفع — إلغاء (الشيف لم يرَ الطلب أصلاً فلا يُشعَر)
      if (new Date(order.created_at) < cutoff) {
        await applyStatusChange(order, 'cancelled', {
          cancel_reason: `لم يكتمل الدفع خلال ${PAYMENT_WINDOW_MIN} دقيقة`,
        })
      }
    } catch (err) {
      // STATUS_CONFLICT = تغيّرت الحالة في الأثناء (دفع أو إلغاء) — طبيعي
      if (err?.code !== 'STATUS_CONFLICT') {
        console.error('[payment-sweep] order', order.id, err.message)
      }
    }
  }
}

let started = false
function startPaymentSweeper() {
  if (started) return
  started = true
  let running = false
  setInterval(async () => {
    if (running) return
    running = true
    try { await sweep() } catch (err) { console.error('[payment-sweep]', err.message) }
    finally { running = false }
  }, SWEEP_EVERY_MS).unref?.()
}

module.exports = { PAYMENT_WINDOW_MIN, ONLINE_METHODS, isOnline, isAwaitingPayment, markPaid, sweep, startPaymentSweeper }
