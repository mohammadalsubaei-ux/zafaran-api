// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  صفحة المتجر العامة — رابط مشاركة للتواصل الاجتماعي
//  GET /store/:id — صفحة ويب تفتح بأي متصفح بدون التطبيق
//  تعرض: اسم المتجر، الحالة، التقييم، القائمة بالصور والأسعار
//  مع وسوم Open Graph لمعاينة غنية عند المشاركة (واتساب/سناب/تويتر)
//  الحقول المعروضة عامة فقط — لا إحداثيات، لا هاتف، لا بيانات حساسة
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const express = require('express')
const router = express.Router()
const supabase = require('../supabase')

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const APP_SCHEME  = 'zafaranapp'
const IOS_URL     = 'https://apps.apple.com/sa/app/id6803207860'
const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.zafaran.app'

const STATUS_LABEL = {
  open:     { text: 'مفتوح الآن — يستقبل طلبات فورية', color: '#4CAF50' },
  preorder: { text: 'حجز مسبق فقط',                    color: '#F0A500' },
  closed:   { text: 'مغلق حالياً',                      color: '#E05252' },
}

router.get('/:id', async (req, res) => {
  try {
    const { data: chef } = await supabase
      .from('chefs')
      .select('id, city, neighborhood, status, rating_avg, total_orders, users ( full_name, avatar_url )')
      .eq('id', req.params.id)
      .single()

    if (!chef) {
      return res.status(404).send(pageShell('المتجر غير موجود',
        '<div class="empty">هذا الرابط لا يشير إلى متجر موجود في زعفران.</div>', {}))
    }

    const { data: menu } = await supabase
      .from('menu_items')
      .select('name, description, price, image_url, status, category')
      .eq('chef_id', req.params.id)
      .neq('status', 'unavailable')
      .order('category')

    const name    = esc(chef.users?.full_name || 'متجر زعفران')
    const avatar  = esc(chef.users?.avatar_url || '')
    const st      = STATUS_LABEL[chef.status] || STATUS_LABEL.open
    const rating  = chef.rating_avg ? Number(chef.rating_avg).toFixed(1) : null
    const area    = [chef.city, chef.neighborhood].filter(Boolean).map(esc).join(' — ')
    const items   = Array.isArray(menu) ? menu : []
    const ogImage = avatar || (items.find(i => i.image_url)?.image_url || '')

    const menuHtml = items.length
      ? items.map(i => `
        <div class="item">
          ${i.image_url ? `<img class="item-img" src="${esc(i.image_url)}" alt="${esc(i.name)}" loading="lazy">` : '<div class="item-img ph"></div>'}
          <div class="item-body">
            <div class="item-name">${esc(i.name)}${i.status === 'preorder' ? ' <span class="badge">حجز مسبق</span>' : ''}</div>
            ${i.description ? `<div class="item-desc">${esc(i.description)}</div>` : ''}
            <div class="item-price">${esc(i.price)} ر.س</div>
          </div>
        </div>`).join('')
      : '<div class="empty">القائمة قيد التجهيز</div>'

    const body = `
      <div class="hero">
        ${avatar ? `<img class="avatar" src="${avatar}" alt="${name}">` : '<div class="avatar ph"></div>'}
        <h1>${name}</h1>
        ${area ? `<div class="area">${area}</div>` : ''}
        <div class="meta">
          <span class="status" style="color:${st.color};border-color:${st.color}55">${st.text}</span>
          ${rating ? `<span class="pill">التقييم ${rating} من 5</span>` : ''}
          ${chef.total_orders ? `<span class="pill">${chef.total_orders} طلب مكتمل</span>` : ''}
        </div>
      </div>
      <h2 class="section">القائمة</h2>
      <div class="menu">${menuHtml}</div>
      <div class="cta">
        <div class="cta-title">اطلب من ${name} عبر تطبيق زعفران</div>
        <div class="cta-sub">منصة الطلب من المتاجر المنزلية — طبخ، حلا، معجنات، قهوة ومؤن</div>

        <a class="btn btn-gold" href="${APP_SCHEME}://chef/${esc(chef.id)}" id="openApp">افتح في التطبيق</a>

        <div class="store-links">
          <a class="btn btn-line" href="${IOS_URL}">آيفون — App Store</a>
          <a class="btn btn-line" href="${ANDROID_URL}">أندرويد — Google Play</a>
        </div>
      </div>`

    res.send(pageShell(`${name} | زعفران`, body, {
      title: `${name} على زعفران`,
      desc: `تصفح قائمة ${name}${area ? ' في ' + area : ''} واطلب عبر تطبيق زعفران`,
      image: ogImage,
      url: `${req.protocol}://${req.get('host')}/store/${esc(chef.id)}`,
    }))
  } catch (err) {
    res.status(500).send(pageShell('خطأ', '<div class="empty">حدث خطأ مؤقت — جرب لاحقاً.</div>', {}))
  }
})

function pageShell(title, body, og) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${og.title ? `
<meta property="og:title" content="${esc(og.title)}">
<meta property="og:description" content="${esc(og.desc)}">
${og.image ? `<meta property="og:image" content="${esc(og.image)}">` : ''}
<meta property="og:url" content="${esc(og.url)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">` : ''}
<style>
  :root { --gold:#F0A500; --bg:#161006; --card:#221706; --line:#3d2a10; --text:#f4e9d6; --muted:#b39b74; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,"Segoe UI",Tahoma,sans-serif; }
  .wrap { max-width:640px; margin:0 auto; padding:24px 16px 48px; }
  .hero { text-align:center; padding:8px 0 20px; }
  .avatar { width:96px; height:96px; border-radius:50%; object-fit:cover; border:2px solid var(--gold); }
  .avatar.ph { display:inline-block; background:var(--card); border:2px solid var(--line); }
  h1 { color:var(--gold); font-size:26px; margin-top:12px; }
  .area { color:var(--muted); font-size:14px; margin-top:4px; }
  .meta { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-top:12px; }
  .status { border:1px solid; border-radius:20px; padding:4px 14px; font-size:13px; }
  .pill { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:4px 14px; font-size:13px; color:var(--muted); }
  .section { color:var(--gold); font-size:18px; border-bottom:1px solid var(--line); padding-bottom:8px; margin:20px 0 14px; }
  .item { display:flex; gap:12px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:10px; margin-bottom:10px; }
  .item-img { width:76px; height:76px; border-radius:10px; object-fit:cover; flex-shrink:0; }
  .item-img.ph { background:var(--bg); border:1px dashed var(--line); }
  .item-body { flex:1; min-width:0; }
  .item-name { font-weight:700; font-size:15px; }
  .badge { font-size:11px; color:var(--gold); border:1px solid var(--gold); border-radius:10px; padding:1px 8px; }
  .item-desc { color:var(--muted); font-size:13px; margin-top:3px; }
  .item-price { color:var(--gold); font-weight:700; margin-top:6px; font-size:14px; }
  .cta { text-align:center; background:var(--card); border:1px solid var(--gold); border-radius:14px; padding:20px 16px; margin-top:24px; }
  .cta-title { color:var(--gold); font-weight:700; font-size:16px; }
  .cta-sub { color:var(--muted); font-size:13px; margin-top:6px; }
  .btn { display:block; text-decoration:none; border-radius:12px; padding:13px 18px; font-size:15px; font-weight:700; margin-top:14px; }
  .btn-gold { background:var(--gold); color:#161006; }
  .btn-line { border:1px solid var(--line); color:var(--text); font-weight:400; font-size:14px; padding:11px 14px; }
  .store-links { display:flex; gap:10px; margin-top:4px; }
  .store-links .btn { flex:1; margin-top:10px; text-align:center; }
  .empty { text-align:center; color:var(--muted); padding:32px 0; }
</style>
</head>
<body><div class="wrap">${body}</div>
<script>
var IOS_FALLBACK = "${IOS_URL}";
var ANDROID_FALLBACK = "${ANDROID_URL}";
(function () {
  // إبراز متجر التطبيقات المناسب لجهاز الزائر فقط — بلا تحويل قسري
  var ua = navigator.userAgent || "";
  var isIOS = /iPad|iPhone|iPod/.test(ua);
  var isAndroid = /Android/.test(ua);
  var links = document.querySelectorAll(".store-links .btn");

  if (links.length === 2) {
    if (isIOS)     { links[1].style.display = "none"; }
    if (isAndroid) { links[0].style.display = "none"; }
  }

  // زر "افتح في التطبيق": إن لم يُفتح خلال ثانية ونصف نوجّه للمتجر المناسب
  var openBtn = document.getElementById("openApp");
  if (!openBtn) return;

  openBtn.addEventListener("click", function (e) {
    if (!isIOS && !isAndroid) return;
    e.preventDefault();

    var fallback = isIOS ? IOS_FALLBACK : ANDROID_FALLBACK;
    var left = false;

    function onHide() { if (document.hidden) left = true; }
    document.addEventListener("visibilitychange", onHide);

    window.location.href = openBtn.getAttribute("href");

    setTimeout(function () {
      document.removeEventListener("visibilitychange", onHide);
      if (!left) window.location.href = fallback;
    }, 1500);
  });
})();
</script>
</body>
</html>`
}

module.exports = router