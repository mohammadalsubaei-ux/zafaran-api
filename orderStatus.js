const supabase = require('./supabase')
const notifyUser = require('./notify')
const { walletAdd, offerUsageAdd } = require('./atomic')

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
  if (status === 'cancelled') {
    // العمود الأصلي بالقاعدة هو cancellation_reason — ونعبّي وقت الإلغاء ومن ألغاه لسجل الأدمن
    if (opts.cancel_reason) updates.cancellation_reason = opts.cancel_reason
    if (opts.cancelled_by)  updates.cancelled_by        = opts.cancelled_by
    updates.cancelled_at = new Date()
  }

  // التحديث مشروط بالحالة التي قرأها المستدعي: طلبان متزامنان (إلغاء العميل وقبول الشيف،
  // أو "تم التسليم" مرتين) كانا ينجحان معاً. الآن ينجح الأول فقط والثاني يرجع 409.
  let query = supabase
    .from('orders')
    .update(updates)
    .eq('id', order.id)
  if (order.status) query = query.eq('status', order.status)

  const { data: updated, error } = await query
    .select('*')
    .maybeSingle()

  if (error) throw error
  if (!updated) {
    const conflict = new Error('تغيّرت حالة الطلب للتو — حدّث الصفحة وحاول مرة ثانية')
    conflict.code = 'STATUS_CONFLICT'
    conflict.expose = true
    throw conflict
  }

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
    // العدّاد يزيد عند الطلب ولم يكن ينقص عند الإلغاء — فينتهي عرض
    // بحد 100 عند 70 استخدامًا حقيقيًا، ويدفع المتجر ثمن ما لم يُستهلك.
    if (updated?.offer_id) {
      const { data: offer } = await supabase
        .from('offers')
        .select('usage_count')
        .eq('id', updated.offer_id)
        .maybeSingle()

      if (offer && Number(offer.usage_count) > 0) {
        await offerUsageAdd(updated.offer_id, -1, offer.usage_count)
      }
    }

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

  // درع الازدواج لكل مستخدم على حدة: فحص عام على مستوى الطلب كان يمنع ترصيد المندوب
  // للأبد إن نجح قيد الشيف وفشل قيده في المحاولة الأولى
  const { data: already } = await supabase
    .from('wallet_transactions')
    .select('id')
    .eq('order_id', order_id)
    .eq('user_id', user_id)
    .eq('type', 'order_earning')
    .limit(1)
  if (already && already.length > 0) return

  // القيد أولا (بمعرف المحفظة — الجدول يشترطه) ثم الرصيد
  const { data: tx, error: txErr } = await supabase.from('wallet_transactions').insert({
    user_id,
    order_id,
    amount,
    type: 'order_earning',
    status: 'completed',
    description,
    currency: 'SAR'
  }).select('id').single()
  if (txErr) {
    // 23505 = الفهرس الفريد منع قيداً مكرراً من نداء متزامن — الأرباح رُصدت مسبقاً
    if (String(txErr.code) === '23505') return
    throw txErr
  }

  try {
    await walletAdd(wallet, amount)
  } catch (updateErr) {
    // فشل الرصيد بعد القيد: نحذف القيد كي لا يبقى أثر ناقص
    await supabase.from('wallet_transactions').delete().eq('id', tx.id)
    throw updateErr
  }
}

async function creditDeliveredOrder(order_id) {
  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, status, chef_id, driver_id, chef_share, driver_share')
      .eq('id', order_id)
      .single()

    if (!order || order.status !== 'delivered') return

    // درع الازدواج صار داخل creditWallet لكل مستخدم (شيف ومندوب كلٌ على حدة)

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