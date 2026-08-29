const express = require('express')
const router = express.Router()
const supabase = require('../supabase')
const { requireUser } = require('../auth')

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  "سفرتي" — قوائم محفوظة
//
//  العميل يحفظ سلته باسم (عزيمة الجمعة، فطور الأسبوع) ويعيدها بضغطة.
//  الأصناف تُقرأ من menu_items وقت العرض لا من لحظة الحفظ — فالسعر
//  والتوفر دائماً محدّثان، ولا تُفتح سلة بأسعار قديمة.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ━━ GET /lists — قوائم صاحب الجلسة ━━
router.get('/', requireUser, async (req, res) => {
  try {
    const { data: lists, error } = await supabase
      .from('saved_lists')
      .select('id, name, chef_id, created_at, saved_list_items(menu_item_id, quantity)')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) throw error
    if (!lists || lists.length === 0) return res.json({ success: true, data: [] })

    const chefIds = [...new Set(lists.map(l => l.chef_id).filter(Boolean))]
    const itemIds = [...new Set(lists.flatMap(l => (l.saved_list_items || []).map(i => i.menu_item_id)))]

    const [{ data: chefs }, { data: items }] = await Promise.all([
      chefIds.length
        ? supabase.from('chefs').select('id, status, is_verified, users(full_name)').in('id', chefIds)
        : Promise.resolve({ data: [] }),
      itemIds.length
        ? supabase.from('menu_items').select('id, name, price, status, image_url').in('id', itemIds)
        : Promise.resolve({ data: [] }),
    ])

    const chefMap = {}
    for (const ch of chefs || []) chefMap[ch.id] = ch

    const itemMap = {}
    for (const it of items || []) itemMap[it.id] = it

    const data = lists.map(l => {
      const chef = chefMap[l.chef_id]

      const live = (l.saved_list_items || [])
        .map(line => {
          const it = itemMap[line.menu_item_id]
          if (!it || it.status === 'unavailable') return null

          return {
            menu_item_id: it.id,
            name: it.name,
            price: Number(it.price),
            image_url: it.image_url,
            quantity: Number(line.quantity) || 1
          }
        })
        .filter(Boolean)

      return {
        id: l.id,
        name: l.name,
        chef_id: l.chef_id,
        chef_name: chef?.users?.full_name || 'متجر',
        chef_status: chef?.status || 'closed',
        // القائمة تبقى ظاهرة ولو نفد بعضها — نخبر العميل بدل حذفها بصمت
        available: chef?.is_verified ? live.length : 0,
        total_saved: (l.saved_list_items || []).length,
        items: live,
        total: live.reduce((sum, i) => sum + i.price * i.quantity, 0),
        created_at: l.created_at
      }
    })

    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر تحميل قوائمك' })
  }
})

// ━━ POST /lists — حفظ السلة الحالية باسم ━━
router.post('/', requireUser, async (req, res) => {
  try {
    const { name, chef_id, items } = req.body

    const title = String(name || '').trim()
    if (!title) {
      return res.status(400).json({ success: false, message: 'اكتب اسماً للقائمة' })
    }
    if (!chef_id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'القائمة فارغة' })
    }

    const { count } = await supabase
      .from('saved_lists')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.userId)

    if (Number(count) >= 20) {
      return res.status(409).json({ success: false, message: 'وصلت الحد الأقصى (20 قائمة) — احذف واحدة أولاً' })
    }

    const { data: list, error } = await supabase
      .from('saved_lists')
      .insert({ user_id: req.userId, name: title, chef_id })
      .select()
      .single()

    if (error) throw error

    const rows = items
      .filter(i => i?.menu_item_id)
      .map(i => ({
        list_id: list.id,
        menu_item_id: i.menu_item_id,
        quantity: Number(i.quantity) || 1
      }))

    const { error: itemsErr } = await supabase.from('saved_list_items').insert(rows)

    if (itemsErr) {
      // لا نترك قائمة فارغة يتيمة
      await supabase.from('saved_lists').delete().eq('id', list.id)
      throw itemsErr
    }

    res.status(201).json({ success: true, data: list })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حفظ القائمة' })
  }
})

// ━━ DELETE /lists/:id ━━
router.delete('/:id', requireUser, async (req, res) => {
  try {
    // الشرط المزدوج يمنع حذف قائمة شخص آخر حتى لو عُرف معرّفها
    const { error } = await supabase
      .from('saved_lists')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId)

    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ success: false, message: 'تعذر حذف القائمة' })
  }
})

module.exports = router
