// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  زعفران — رمز التحقق عبر Authentica (authentica.sa)
//
//  يستبدل Firebase Phone Auth. الخادم هو الذي يرسل ويتحقق؛ التطبيق
//  لا يحمل مفتاحاً ولا يثبت شيئاً بنفسه.
//
//  متغيرات Railway المطلوبة:
//    AUTHENTICA_API_KEY      مفتاح من portal.authentica.sa/settings/apikeys
//    AUTHENTICA_TEMPLATE_ID  (اختياري) معرّف القالب "رمز التحقق لتطبيق زعفران: {otp}"
//    OTP_TICKET_SECRET       (اختياري) سرّ توقيع تذكرة التسجيل — إن غاب يُشتق من المفتاح
//    OTP_TEST_PHONE          (اختياري، للاختبار فقط) رقم بصيغة 05xxxxxxxx لا تُرسل له رسالة
//    OTP_TEST_CODE           (اختياري) الرمز الثابت لرقم الاختبار — احذف الاثنين قبل الإطلاق
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const crypto = require('crypto')

const BASE_URL = 'https://api.authentica.sa'
const METHODS = new Set(['sms', 'whatsapp'])

function apiKey() {
  return process.env.AUTHENTICA_API_KEY || ''
}

function isConfigured() {
  return Boolean(apiKey())
}

// ── صيغ الرقم ──
// المخزّنة في قاعدتنا: 05xxxxxxxx · التي تفهمها Authentica: +9665xxxxxxxx
function normalizeLocal(raw) {
  let n = String(raw || '').replace(/[^0-9]/g, '')
  if (n.startsWith('00966')) n = n.slice(5)
  if (n.startsWith('966'))   n = n.slice(3)
  if (n.startsWith('0'))     n = n.slice(1)
  if (!/^5\d{8}$/.test(n)) return null
  return '0' + n
}

function toE164(local) {
  return '+966' + local.slice(1)
}

// ── رقم الاختبار (بلا رسالة، رمز ثابت) ──
function isTestPhone(local) {
  const t = normalizeLocal(process.env.OTP_TEST_PHONE)
  return Boolean(t && process.env.OTP_TEST_CODE && t === local)
}

// ── استدعاء Authentica ──
async function call(path, body) {
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Authorization': apiKey(),
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, json }
}

// ترجع { ok, message? }
async function sendOtp(local, method = 'sms') {
  if (isTestPhone(local)) return { ok: true, test: true }
  if (!METHODS.has(method)) method = 'sms'

  const body = { method, phone: toE164(local) }
  if (process.env.AUTHENTICA_TEMPLATE_ID) body.template_id = process.env.AUTHENTICA_TEMPLATE_ID

  const r = await call('/api/v2/send-otp', body)
  if (r.ok) return { ok: true }

  // لا نسجّل الرقم — الحالة والرسالة فقط
  console.error('[otp] send failed', r.status, r.json?.message || r.json?.error || '')

  if (r.status === 401) return { ok: false, message: 'خدمة التحقق غير مهيأة على الخادم' }
  if (r.status === 429) return { ok: false, message: 'محاولات كثيرة — انتظر قليلاً وحاول مرة ثانية' }
  if (r.status === 402 || /balance|credit/i.test(String(r.json?.message || '')))
    return { ok: false, message: 'تعذر إرسال الرمز حالياً — حاول لاحقاً' }
  return { ok: false, message: 'تعذر إرسال الرمز — تأكد من الرقم وحاول مرة ثانية' }
}

// ترجع true/false
async function verifyOtp(local, otp) {
  if (isTestPhone(local)) return String(otp) === String(process.env.OTP_TEST_CODE)

  const r = await call('/api/v2/verify-otp', { phone: toE164(local), otp: String(otp) })
  if (!r.ok || !r.json) return false

  // الرد الفعلي (اختبار 10 سبتمبر): الرفض يرجع 422 مع { status: false, message: "Failed to verify OTP" }.
  // فالنجاح = رد 2xx مع status/verified/success صحيحة — أي صيغة منها تكفي لأن الفشل لا يمر بـ2xx.
  const j = r.json
  return j.status === true || j.verified === true || j.success === true || j?.data?.verified === true
}

// ━━ تذكرة التسجيل ━━
// بعد نجاح الرمز لرقم جديد نطلب الاسم. الرمز يُستهلك مرة واحدة ولا يُعاد
// التحقق منه، فنُصدر تذكرة موقّعة تثبت أن هذا الرقم تحقّق قبل دقائق.
const TICKET_TTL_MS = 10 * 60 * 1000

function ticketSecret() {
  return process.env.OTP_TICKET_SECRET || ('zafaran-otp:' + apiKey())
}

function sign(payload) {
  return crypto.createHmac('sha256', ticketSecret()).update(payload).digest('hex')
}

function issueTicket(local) {
  const payload = `${local}.${Date.now() + TICKET_TTL_MS}`
  return Buffer.from(payload).toString('base64url') + '.' + sign(payload)
}

// ترجع الرقم المحلي إن كانت التذكرة صالحة، وإلا null
function readTicket(ticket) {
  try {
    const [b64, sig] = String(ticket || '').split('.')
    if (!b64 || !sig) return null
    const payload = Buffer.from(b64, 'base64url').toString()
    const expected = sign(payload)
    if (sig.length !== expected.length) return null
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
    const [local, exp] = payload.split('.')
    if (Number(exp) < Date.now()) return null
    return normalizeLocal(local)
  } catch {
    return null
  }
}

// ━━ حد الإرسال لكل رقم (إضافة لحد الـIP في auth.js) ━━
const perPhone = new Map()
const PHONE_WINDOW_MS = 10 * 60 * 1000
const PHONE_MAX = 4

function phoneAllowed(local) {
  const now = Date.now()
  const rec = perPhone.get(local)
  if (!rec || now > rec.resetAt) {
    perPhone.set(local, { count: 1, resetAt: now + PHONE_WINDOW_MS })
    return true
  }
  rec.count += 1
  return rec.count <= PHONE_MAX
}

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of perPhone) if (now > v.resetAt) perPhone.delete(k)
}, 10 * 60 * 1000).unref?.()

module.exports = {
  isConfigured,
  normalizeLocal,
  sendOtp,
  verifyOtp,
  issueTicket,
  readTicket,
  phoneAllowed,
}
