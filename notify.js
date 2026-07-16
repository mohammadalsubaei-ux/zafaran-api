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
      const messages = tokens.map(t => ({ to: t.token, sound: 'default', title, body, data }))
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(messages),
      })
    }
  } catch (err) {
    console.error('notifyUser failed:', err.message)
  }
}

module.exports = notifyUser