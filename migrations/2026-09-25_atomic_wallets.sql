-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--  زعفران — عمليات ذرّية للمحافظ والعروض + فهارس تمنع التكرار
--
--  التشغيل: Supabase → SQL Editor → الصق الملف كاملاً → Run
--  آمن لإعادة التشغيل (CREATE OR REPLACE / IF NOT EXISTS).
--  الخادم يعمل قبل تشغيله وبعده: إن لم يجد الدوال يرجع للطريقة القديمة.
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- ١) إضافة/خصم رصيد في خطوة واحدة (بدل قراءة الرصيد ثم كتابته — كانت تضيّع أرباحاً عند التزامن)
CREATE OR REPLACE FUNCTION public.wallet_add(p_wallet_id uuid, p_amount numeric)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.wallets
     SET balance           = COALESCE(balance, 0) + p_amount,
         available_balance = COALESCE(available_balance, 0) + p_amount
   WHERE id = p_wallet_id;
$$;

-- ٢) خصم سحب فقط إن كفى الرصيد المتاح — يرجع true عند النجاح
CREATE OR REPLACE FUNCTION public.wallet_withdraw(p_wallet_id uuid, p_amount numeric)
RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.wallets
     SET balance           = COALESCE(balance, 0) - p_amount,
         available_balance = COALESCE(available_balance, 0) - p_amount
   WHERE id = p_wallet_id
     AND COALESCE(available_balance, 0) >= p_amount;
  RETURN FOUND;
END;
$$;

-- ٣) عدّاد استخدام العرض بزيادة/نقص ذرّي، ولا ينزل تحت الصفر
CREATE OR REPLACE FUNCTION public.offer_usage_add(p_offer_id uuid, p_delta integer)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.offers
     SET usage_count = GREATEST(0, COALESCE(usage_count, 0) + p_delta)
   WHERE id = p_offer_id;
$$;

-- ٤) مهم جداً: هذه الدوال للخادم فقط.
--    Supabase يتيح دوال public لمفتاح التطبيق العام (anon) — بدون هذا يقدر أي أحد يضيف لنفسه رصيداً.
REVOKE ALL ON FUNCTION public.wallet_add(uuid, numeric)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wallet_withdraw(uuid, numeric)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.offer_usage_add(uuid, integer)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_add(uuid, numeric)      TO service_role;
GRANT EXECUTE ON FUNCTION public.wallet_withdraw(uuid, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.offer_usage_add(uuid, integer) TO service_role;

-- ٥) قيد أرباح واحد لكل (طلب، مستخدم، نوع الربح) — يمنع ترصيد الطلب مرتين عند التسليم المتزامن.
--    الوصف يميّز ربح المتجر عن ربح التوصيل (لو كان الشخص نفسه الطرفين).
--    إن وُجدت تكرارات قديمة لا يُنشأ الفهرس، وتظهر رسالة بعددها لمراجعتها يدوياً.
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT order_id, user_id, description FROM public.wallet_transactions
     WHERE type = 'order_earning' AND order_id IS NOT NULL
     GROUP BY order_id, user_id, description HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE NOTICE 'wallet_transactions: % duplicated order earnings found — index NOT created. Review them first.', dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_tx_one_earning_per_order_user
      ON public.wallet_transactions (order_id, user_id, description)
      WHERE type = 'order_earning' AND order_id IS NOT NULL;
  END IF;
END $$;

-- ٦) طلب سحب معلّق واحد لكل مستخدم (الكود يعتمد عليه لمنع الطلبات المتزامنة)
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT user_id FROM public.withdrawals
     WHERE status = 'pending'
     GROUP BY user_id HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE NOTICE 'withdrawals: % users have more than one pending withdrawal — index NOT created. Review them first.', dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_one_pending_per_user
      ON public.withdrawals (user_id)
      WHERE status = 'pending';
  END IF;
END $$;

-- للتحقق بعد التشغيل:
--   SELECT proname FROM pg_proc WHERE proname IN ('wallet_add','wallet_withdraw','offer_usage_add');
--   SELECT indexname FROM pg_indexes WHERE indexname IN ('wallet_tx_one_earning_per_order_user','withdrawals_one_pending_per_user');
