const supabase = require('./supabase')
const notifyUser = require('./notify')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  محرك حالات الطلبات — المصدر الوحيد بكل المشروع
//  يستخدمه المساران: تطبيق الشيف (بضوابط الملكية) ولوحة الأدمن
//
//  المسؤوليات: تحديث الحالة والطوابع الزمنية، نداء المناديب عند الجاهزية،
//  مهلة "لا يوجد مندوب"، إشعار العميل، وعند الإلغاء: تحرير المندوب وإشعار الأطراف
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const STATUS_AR = {
  pending:    'قيد الانتظار',
  accepted:   'مقبول',
  preparing:  'قيد التحضير',
  ready:      'جاهز',
  delivering: 'في الطريق',
  delivered:  'تم التسليم',
  cancelled:  'ملغي',
}

const TERMINAL_STATUSES = ['delivered', 'cancelled']

// انتقالات الشيف من التطبيق: تقدم بمسار الطلب + إلغاء قبل الجاهزية
const CHEF_TRANSITIONS = {
  pending:   ['accepted', 'cancelled'],
  accepted:  ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
}

// انتقالات الأدمن: أي تقدم للأمام + إلغاء من أي حالة غير نهائية
const ADMIN_TRANSITIONS = {
  pending:    ['accepted', 'preparing', 'ready', 'cancelled'],
  accepted:   ['preparing', 'ready', 'cancelled'],
  preparing:  ['ready', 'cancelled'],
  ready:      ['delivering', 'cancelled'],
  delivering: ['delivered', 'cancelled'],
}

// جلب نواة الطلب للفحوصات قبل أي تغيير
async function getOrderCore(order_id) {
  const { data } = await supabase
    .from('orders')
    .select('id, status, customer_id, chef_id, driver_id, delivery_address')
    .eq('id', order_id)
    .single()
  return data || null
}

// تنفيذ تغيير الحالة بعد نجاح كل الفحوصات لدى المستدعي
async function applyStatusChange(order, status, opts = {}) {
  const updates = { status }
  if (status === 'accepted')  updates.accepted_at  = new Date()
  if (status === 'ready')     updates.ready_at     = new Date()
  if (status === 'delivered') updates.delivered_at = new Date()
  if (status === 'cancelled' && opts.cancel_reason) updates.cancel_reason = opts.cancel_reason

  const { data: updated, error } = await supabase
    .from('orders')
    .update(updates)
    .eq('id', order.id)
    .select('*')
    .single()

  if (error) throw error

  // ━━━ عند الجاهزية: نداء كل المناديب المتاحين + مهلة دقيقة ━━━
  if (status === 'ready' && order.delivery_address !== 'استلام شخصي') {
    const { data: availableDrivers } = await supabase
      .from('drivers')
      .select('id, user_id')
      .eq('is_available', true)

    if (availableDrivers && availableDrivers.length > 0) {
      await Promise.all(
        availableDrivers.map(driver =>
          notifyUser(
            driver.user_id,
            'طلب توصيل جديد',
            'يوجد طلب بانتظار مندوب — اضغط لقبوله',
            'delivery_request',
            { order_id: order.id }
          )
        )
      )
    }

    // بعد دقيقة — إذا ما في مندوب قبل
    setTimeout(async () => {
      const { data: currentOrder } = await supabase
        .from('orders')
        .select('id, driver_id, status, customer_id')
        .eq('id', order.id)
        .single()

      if (currentOrder && !currentOrder.driver_id && currentOrder.status === 'ready') {
        await notifyUser(
          currentOrder.customer_id,
          'لا يوجد مندوب متاح',
          'لا يوجد مندوب متاح حالياً، هل تريد الانتظار أو الاستلام الشخصي؟',
          'no_driver_available',
          { order_id: order.id, options: ['wait', 'pickup'] }
        )
      }
    }, 60 * 1000)
  }

  // ━━━ عند الإلغاء: تحرير المندوب المرتبط وإشعار الأطراف ━━━
  if (status === 'cancelled') {
    if (order.driver_id) {
      const { data: driver } = await supabase
        .from('drivers')
        .update({ is_available: true })
        .eq('id', order.driver_id)
        .select('user_id')
        .single()

      if (driver?.user_id) {
        await notifyUser(
          driver.user_id,
          'تم إلغاء الطلب',
          'الطلب الذي كنت توصله تم إلغاؤه — أنت متاح الآن لطلبات جديدة',
          'order_cancelled',
          { order_id: order.id }
        )
      }
    }

    if (opts.notifyChef) {
      const { data: chef } = await supabase
        .from('chefs')
        .select('user_id')
        .eq('id', order.chef_id)
        .single()

      if (chef?.user_id) {
        await notifyUser(
          chef.user_id,
          'تم إلغاء الطلب',
          opts.cancel_reason
            ? `تم إلغاء الطلب من الإدارة — السبب: ${opts.cancel_reason}`
            : 'تم إلغاء الطلب من الإدارة',
          'order_cancelled',
          { order_id: order.id }
        )
      }
    }
  }

  // ━━━ ترصيد الأرباح عند التسليم ━━━
  if (status === 'delivered') {
    await creditDeliveredOrder(order.id)
  }

  // ━━━ إشعار العميل ━━━
  const statusMessages = {
    accepted:   { title: 'تم قبول طلبك',   body: 'الشيفة قبلت طلبك وبدأت التحضير', type: 'order_accepted'   },
    preparing:  { title: 'طلبك يُحضَّر',    body: 'الشيفة تحضر وجبتك الآن',         type: 'order_preparing'  },
    ready:      { title: 'طلبك جاهز',       body: 'طلبك جاهز للاستلام أو التوصيل',  type: 'order_ready'      },
    delivering: { title: 'في الطريق',       body: 'المندوب توجه بطلبك',              type: 'order_delivering' },
    delivered:  { title: 'وصل طلبك',        body: 'استمتع بوجبتك! لا تنسى التقييم', type: 'order_delivered'  },
    cancelled:  {
      title: 'تم إلغاء الطلب',
      body: opts.cancel_reason ? `تم إلغاء طلبك — السبب: ${opts.cancel_reason}` : 'تم إلغاء طلبك',
      type: 'order_cancelled'
    },
  }

  if (statusMessages[status]) {
    await notifyUser(
      order.customer_id,
      statusMessages[status].title,
      statusMessages[status].body,
      statusMessages[status].type,
      { order_id: order.id }
    )
  }

  return updated
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ترصيد أرباح الطلب المسلّم بمحافظ الشيف والمندوب
//  محصّنة ضد الازدواج: قيد واحد لكل طلب مهما تكرر النداء
//  لا ترمي أخطاء أبداً — تسجّلها فقط كي لا تعطل مسار التسليم
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function creditWallet(user_id, amount, walletType, description, order_id) {
  let { data: wallet } = await supabase
    .from('wallets')
    .select('id, balance, available_balance')
    .eq('user_id', user_id)
    .maybeSingle()

  if (!wallet) {
    const { data: created, error: createErr } = await supabase
      .from('wallets')
      .insert({
        user_id,
        wallet_type: walletType,
        is_withdrawable: true,
        balance: 0,
        available_balance: 0,
        pending_balance: 0,
        currency: 'SAR'
      })
      .select('id, balance, available_balance')
      .single()
    if (createErr) throw createErr
    wallet = created
  }

  const { error: updateErr } = await supabase
    .from('wallets')
    .update({
      balance: Number(wallet.balance || 0) + amount,
      available_balance: Number(wallet.available_balance || 0) + amount
    })
    .eq('id', wallet.id)
  if (updateErr) throw updateErr

  const { error: txErr } = await supabase.from('wallet_transactions').insert({
    user_id,
    order_id,
    amount,
    type: 'order_earning',
    status: 'completed',
    description,
    currency: 'SAR'
  })
  if (txErr) throw txErr
}

async function creditDeliveredOrder(order_id) {
  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, status, chef_id, driver_id, chef_share, driver_share')
      .eq('id', order_id)
      .single()

    if (!order || order.status !== 'delivered') return

    // درع الازدواج: قيد سابق لنفس الطلب = لا شيء يُعاد
    const { data: existing } = await supabase
      .from('wallet_transactions')
      .select('id')
      .eq('order_id', order_id)
      .eq('type', 'order_earning')
      .limit(1)
    if (existing && existing.length > 0) return

    const shortId = String(order.id).slice(0, 8)

    const chefShare = Number(order.chef_share || 0)
    if (order.chef_id && chefShare > 0) {
      const { data: chef } = await supabase
        .from('chefs').select('user_id').eq('id', order.chef_id).single()
      if (chef?.user_id) {
        await creditWallet(chef.user_id, chefShare, 'chef', 'أرباح الطلب #' + shortId, order.id)
      }
    }

    const driverShare = Number(order.driver_share || 0)
    if (order.driver_id && driverShare > 0) {
      const { data: driver } = await supabase
        .from('drivers').select('user_id').eq('id', order.driver_id).single()
      if (driver?.user_id) {
        await creditWallet(driver.user_id, driverShare, 'driver', 'أرباح توصيل الطلب #' + shortId, order.id)
      }
    }
  } catch (err) {
    console.error('creditDeliveredOrder failed for order', order_id, ':', err.message)
  }
}

module.exports = { STATUS_AR, TERMINAL_STATUSES, CHEF_TRANSITIONS, ADMIN_TRANSITIONS, getOrderCore, applyStatusChange, creditDeliveredOrder }