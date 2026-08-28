require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const app     = express()
const path    = require('path')

// ── Middleware ──
// ترويسات أمان أساسية — بلا مكتبة إضافية
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  next()
})

// التطبيق الجوّال لا يرسل Origin، فيُسمح له. أما المتصفحات فتُقيَّد
// بقائمة معلومة حتى لا يستدعي موقع خبيث الخادم من متصفح الضحية.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true)
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true)
    return cb(null, ALLOWED_ORIGINS.includes(origin))
  }
}))

// جسم الطلب محدود الحجم — يمنع إغراق الخادم بحمولات ضخمة
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  الروابط العميقة — ملفا التحقق
//  بدونهما لا يفتح رابط /store/:id التطبيق، بل المتصفح فقط.
//  شرط آبل: يُقدَّم بترويسة application/json وبلا أي تحويل.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const IOS_TEAM_ID   = process.env.IOS_TEAM_ID   || '9994A969J9'
const IOS_BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'com.zafaran.app'
const ANDROID_PKG   = process.env.ANDROID_PKG   || 'com.zafaran.app'
// بصمة توقيع أندرويد (SHA-256) — تُؤخذ من: eas credentials
const ANDROID_SHA256 = process.env.ANDROID_SHA256 || ''

app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json').json({
    applinks: {
      apps: [],
      details: [
        {
          appID: `${IOS_TEAM_ID}.${IOS_BUNDLE_ID}`,
          paths: ['/store/*']
        }
      ]
    }
  })
})

app.get('/.well-known/assetlinks.json', (req, res) => {
  if (!ANDROID_SHA256) {
    return res.type('application/json').json([])
  }

  res.type('application/json').json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PKG,
        sha256_cert_fingerprints: [ANDROID_SHA256]
      }
    }
  ])
})

app.use('/admin', express.static(path.join(__dirname, 'public/admin')))
app.use('/legal', express.static(path.join(__dirname, 'public/legal')))

// ── Routes ──
app.use('/api/users',     require('./routes/users'))
app.use('/api/chefs',     require('./routes/chefs'))
app.use('/api/orders',    require('./routes/orders'))
app.use('/api/admin',     require('./routes/admin'))
app.use('/api/wallet',    require('./routes/wallet'))
app.use('/api/settings', require('./routes/settings'))
app.use('/api/offers',    require('./routes/offers'))
app.use('/api/cities',    require('./routes/cities'))
app.use('/api/banners',   require('./routes/banners'))
app.use('/api/menu',      require('./routes/menu'))
app.use('/api/addresses', require('./routes/addresses'))
app.use('/api/drivers',   require('./routes/drivers'))
app.use('/api/payment',   require('./routes/payment'))
app.use('/api/tracking',  require('./routes/tracking'))
app.use('/api/notifications', require('./routes/notifications'))
app.use('/store', require('./routes/store'))

// الصفحات القانونية العامة (مطلوبة لمتاجر التطبيقات)
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public/legal/privacy.html')))
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public/legal/terms.html')))

// فحص صحة السيرفر — للمراقبة السريعة من لوحة الأدمن
app.get('/api/health', (req, res) => res.json({ success: true, service: 'zafaran-api', time: new Date().toISOString() }))

// ── Health Check ──
app.get('/', (req, res) => {
  res.json({ app: 'زعفران API', version: '1.0.0', status: '🟢 شغّال' })
})

// ── Error Handler ──
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ success: false, message: 'خطأ في السيرفر' })
})

// ── Start ──
const PORT = process.env.PORT || 3000
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  مُعقِّم الأخطاء — رسائل قواعد البيانات تكشف أسماء الجداول والأعمدة.
//  نسجّلها في السجل ونرسل رسالة عامة للعميل.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err?.message)
  if (res.headersSent) return next(err)
  res.status(500).json({ success: false, message: 'حدث خطأ غير متوقع — حاول مرة ثانية' })
})

app.listen(PORT, () => {
  console.log(`\n🍲 زعفران API شغّال على http://localhost:${PORT}\n`)
})