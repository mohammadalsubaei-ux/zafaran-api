const API = "https://zafaran-backend-production.up.railway.app/api/admin";

function getToken() {
  return localStorage.getItem("zafaran_admin_token");
}

function setToken(token) {
  localStorage.setItem("zafaran_admin_token", token);
}

function clearToken() {
  localStorage.removeItem("zafaran_admin_token");
}

// نداء API موحّد: يضيف التوكن تلقائياً، ويحوّل لصفحة الدخول لو انتهت الجلسة
async function authFetch(path, options = {}) {
  const token = getToken();
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    options.headers || {},
    token ? { Authorization: "Bearer " + token } : {}
  );

  const res = await fetch(API + path, Object.assign({}, options, { headers }));

  if (res.status === 401) {
    clearToken();
    window.location.href = "index.html";
    return null;
  }

  return res.json();
}

// يتأكد من صلاحية الجلسة، ولو فاشلة يرجّع لصفحة الدخول — يُستدعى بأول كل صفحة محمية
async function requireAuth() {
  const token = getToken();
  if (!token) {
    window.location.href = "index.html";
    return false;
  }
  const json = await authFetch("/auth/me");
  if (!json || !json.success) {
    window.location.href = "index.html";
    return false;
  }
  return true;
}

async function logout() {
  await authFetch("/auth/logout", { method: "POST" });
  clearToken();
  window.location.href = "index.html";
}

// يبني الشريط الجانبي وتظليل الصفحة النشطة
function renderSidebar(active) {
  const items = [
    { id: "dashboard", label: "لوحة المعلومات", href: "dashboard.html" },
    { id: "orders",    label: "الطلبات",        href: "orders.html" },
    { id: "chefs",     label: "الشيفات",        href: "chefs.html" },
    { id: "drivers",   label: "المناديب",       href: "drivers.html" },
    { id: "settings",  label: "الإعدادات",      href: "settings.html" },
  ];

  const nav = document.getElementById("sidebar-nav");
  if (!nav) return;

  nav.innerHTML = items
    .map(
      (item) =>
        `<div class="nav-item${item.id === active ? " active" : ""}" onclick="location.href='${item.href}'">${item.label}</div>`
    )
    .join("");
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("ar-SA", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function money(value) {
  const n = Number(value || 0);
  return n.toFixed(2) + " ر.س";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}