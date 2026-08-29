const supabase = require('./supabase')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  الموديول الموحّد للإشعارات — المصدر الوحيد بكل المشروع
//  يحفظ الإشعار بجدول notifications (للعرض داخل التطبيق)
//  + يرسل push فعلي للجوال عبر Expo
//
//  الاستخدام من أي route:
//    const notifyUser = require('../notify')
//    await notifyUser(user_id, 'العنوان', 'النص', 'النوع', { order_id })
//
//  ملاحظة: فشل الإرسال لا يكسر تدفق الطلب — يُسجَّل الخطأ فقط
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function notifyUser(user_id, title, body, type, data = {}) {
  try {
    await supabase.from('notifications').insert({ user_id, title, body, type, data })

    const { data: tokens } = await supabase
      .from('push_tokens').select('token').eq('user_id', user_id)

    if (tokens && tokens.length > 0) {
      const list = tokens.map(t => t.token)
      const messages = list.map(tok => ({ to: tok, sound: 'default', title, body, data }))

      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(messages),
      })

      // كان الرد يُهمَل تماماً — فلا نعلم أن الإشعار لم يصل، ولا نحذف
      // رموز الأجهزة الميتة فتتراكم وتبطئ الإرسال.
      const json = await res.json().catch(() => null)

      if (!res.ok) {
        console.error('push send failed:', res.status, JSON.stringify(json))
        return
      }

      const tickets = Array.isArray(json?.data) ? json.data : []
      const dead = []

      tickets.forEach((ticket, i) => {
        if (ticket?.status !== 'error') return

        const reason = ticket?.details?.error
        console.error('push ticket error:', reason, ticket?.message)

        // الجهاز لم يعد مسجّلاً أو الرمز غير صالح — نحذفه
        if (reason === 'DeviceNotRegistered' || reason === 'InvalidCredentials') {
          if (list[i]) dead.push(list[i])
        }
      })

      if (dead.length > 0) {
        await supabase.from('push_tokens').delete().in('token', dead)
      }
    }
  } catch (err) {
    console.error('notifyUser failed:', err.message)
  }
}

module.exports = notifyUser