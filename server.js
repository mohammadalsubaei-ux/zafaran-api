require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const app     = express()
const path    = require('path')

// ── Middleware ──
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use('/admin', express.static(path.join(__dirname, 'public/admin')))

// ── Routes ──
app.use('/api/users',     require('./routes/users'))
app.use('/api/chefs',     require('./routes/chefs'))
app.use('/api/orders',    require('./routes/orders'))
app.use('/api/admin',     require('./routes/admin'))
app.use('/api/wallet',    require('./routes/wallet'))
app.use('/api/cities',    require('./routes/cities'))
app.use('/api/banners',   require('./routes/banners'))
app.use('/api/menu',      require('./routes/menu'))
app.use('/api/addresses', require('./routes/addresses'))
app.use('/api/drivers',   require('./routes/drivers'))
app.use('/api/payment',   require('./routes/payment'))
app.use('/api/tracking',  require('./routes/tracking'))
app.use('/api/notifications', require('./routes/notifications'))

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
app.listen(PORT, () => {
  console.log(`\n🍲 زعفران API شغّال على http://localhost:${PORT}\n`)
})