# 🍲 زعفران — Backend API

## التشغيل

```bash
# 1. نزّل المكتبات
npm install

# 2. أنشئ ملف .env من المثال
cp .env.example .env

# 3. شغّل السيرفر
npm run dev
```

## API Endpoints

### المستخدمين
| Method | Endpoint | الوظيفة |
|--------|----------|---------|
| POST | /api/users/register | تسجيل مستخدم جديد |
| POST | /api/users/login | دخول برقم الجوال |
| GET | /api/users/:id/notifications | إشعارات المستخدم |

### الطباخات
| Method | Endpoint | الوظيفة |
|--------|----------|---------|
| GET | /api/chefs | كل الطباخات المتاحة |
| GET | /api/chefs?city=بريدة | فلترة بالمدينة |
| GET | /api/chefs?is_open=true | المتاحات فقط |
| GET | /api/chefs/:id | طباخة + قائمتها |
| PATCH | /api/chefs/:id/toggle | فتح/إغلاق |

### الطلبات
| Method | Endpoint | الوظيفة |
|--------|----------|---------|
| POST | /api/orders | طلب جديد |
| GET | /api/orders/:id | تفاصيل طلب |
| PATCH | /api/orders/:id/status | تحديث الحالة |
| GET | /api/orders/customer/:id | طلبات العميل |

### الإدارة
| Method | Endpoint | الوظيفة |
|--------|----------|---------|
| GET | /api/admin/stats | إحصائيات اللوحة |
| GET | /api/admin/orders | كل الطلبات |
| PATCH | /api/admin/chefs/:id/verify | توثيق طباخة |

## مثال — إنشاء طلب

```json
POST /api/orders
{
  "customer_id": "uuid",
  "chef_id": "uuid",
  "items": [
    { "menu_item_id": "uuid", "quantity": 1 },
    { "menu_item_id": "uuid", "quantity": 2 }
  ],
  "delivery_address": "بريدة، حي النرجس",
  "delivery_lat": 26.3260,
  "delivery_lng": 43.9750,
  "payment_method": "stc_pay",
  "notes": "بدون بصل"
}
```
