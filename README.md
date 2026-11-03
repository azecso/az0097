# نظام المحاسبة والمخزون والشراكة

نظام ويب عربي (RTL) لإدارة المبيعات والمشتريات والمخزون ورأس المال والشراكة 50/50.
المتطلبات: [SRS](docs/phase-0/README.md) — التصميم المعتمد في `docs/phase-0`، وتقرير التنفيذ في [`docs/phase-1/REPORT.md`](docs/phase-1/REPORT.md).

**الحالة:** المراحل 0–6 منجزة (تقارير في `docs/phase-1` … `docs/phase-6`). **لم يُنشر بعد على Staging** ولم تُشغَّل صورة Docker هنا — راجع [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) لمصفوفة القبول والفجوات المعروفة.

الوثائق: [`RUNBOOK`](docs/RUNBOOK.md) (تشغيل/نسخ/استعادة) · [`DEPLOYMENT`](docs/DEPLOYMENT.md) (VPS) · [`SECURITY`](docs/SECURITY.md) · [`ACCEPTANCE`](docs/ACCEPTANCE.md).

## المكوّنات
| المسار | المحتوى |
|---|---|
| `app/` | Next.js 15 + TypeScript + PostgreSQL (الواجهة + API) |
| `app/db/migrations/` | ترحيلات SQL (تُطبَّق بالترتيب مع checksum) |
| `app/tests/` | اختبارات تكامل على PostgreSQL حقيقي |
| `ops/`, `docker-compose.yml` | Caddy (HTTPS) ← التطبيق ← PostgreSQL |
| `app/e2e/` | اختبارات متصفح (Playwright): `npm run e2e` (تحتاج `E2E_ADMIN_URL` و`CHROMIUM_PATH`) |
| `ops/` | نسخ احتياطي مشفّر، استعادة، اختبار استعادة |
| `docs/phase-0/` | ADR، ERD، التصميم المحاسبي، الاختبارات |

## التشغيل بـ Docker
```bash
cp .env.example .env          # ثم عدّل القيم: كلمات مرور قوية، DOMAIN
docker compose up -d --build  # db → migrate → app → caddy

# إنشاء الشركة والمالك (مرة واحدة فقط) — كلمة المرور تُقرأ من البيئة ولا تُخزَّن نصاً:
docker compose run --rm \
  -e COMPANY_NAME="اسم الشركة" -e OWNER_USERNAME=owner -e OWNER_PASSWORD='كلمة-مرور-قوية-12+' \
  migrate npx tsx scripts/bootstrap.ts
```
ثم افتح `https://<DOMAIN>` وسجّل الدخول. للتجربة المحلية: `DOMAIN=localhost` و`COOKIE_SECURE=false` عبر http.

## التطوير والاختبار
```bash
cd app && npm ci
export DATABASE_URL=postgres://erp_app:...@localhost:5432/erp     # دور التطبيق (ليس المالك)
npm run migrate        # بمتغيرات DATABASE_URL (مالك القاعدة) + APP_DB_USER/APP_DB_PASSWORD
npm run dev
# الاختبارات (تنشئ قاعدة مؤقتة لكل ملف):
TEST_ADMIN_URL=postgres://postgres@localhost:5432/postgres npm test
npm run lint           # يمنع float للمال، ON DELETE CASCADE، ويفحص الأنواع
```

## التراجع (Rollback)
- التطبيق: `git checkout <الإصدار السابق> && docker compose up -d --build`.
- قاعدة البيانات: الترحيلات للأمام فقط (forward-only)؛ قبل أي ترحيل جديد على بيانات حقيقية خذ نسخة (`pg_dump`) — النسخ المشفّر: `ops/backup.sh` (انظر RUNBOOK).
- بيئة تجريبية كاملة: `docker compose down -v` (يحذف بيانات التجربة).

## الأمن (ما هو مفعّل الآن)
Argon2id، جلسات في قاعدة البيانات (التوكن المخزَّن Hash فقط) بكوكي HttpOnly/SameSite، CSRF (رمز + فحص Origin)، قفل الحساب بعد 5 محاولات، تحديد معدل، CSP وHSTS، صلاحيات على الخادم، RLS لعزل الشركة بدور قاعدة بيانات غير مالك، سجل تدقيق للإضافة فقط، لا أسرار في المستودع (`.env.example` فقط).
