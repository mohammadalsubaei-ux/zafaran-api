const supabase = require('./supabase')

// ━━━ إرسال إشعار لمستخدم ━━━
async function sendPushNotification(userId, title, body, data = {}) {
  try {
    // جلب tokens المستخدم
    const { data: tokens, error } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId)

    if (error || !tokens || tokens.length === 0) return

    // إرسال عبر Expo Push API
    const messages = tokens.map(t => ({
      to:    t.token,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
    }))

    await fetch('https://exp.host/--/api/v2/push/send', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':        'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
    })

    // حفظ الإشعار في قاعدة البيانات
    await supabase.from('notifications').insert({
      user_id: userId,
      title,
      body,
      type: data.type || 'general',
      data,
    })

  } catch (err) {
    console.error('خطأ في إرسال الإشعار:', err.message)
  }
}

module.exports = { sendPushNotification }
