# دليل النشر (VPS + Docker Compose)

> **لا أسعار هنا بقصد.** اجمع عروض الأسعار الفعلية وقت النشر من 2–3 مزودين (بنفس الحد الأدنى التقني أدناه) واختر بحسب: السعر الفعلي، موقع مركز البيانات، سياسة النسخ/اللقطات، تقييم السمعة، وسهولة الدفع لديك.
> **ما لم يُجرَّب في بيئة التطوير:** `docker compose up` الفعلي وبناء صورة Chromium (لا يوجد Docker daemon هنا). أول نشر **تجريبي (Staging)** يجب أن يكتشف أي خلل فيهما قبل الإنتاج — وهذا مقصود في الخطة.

## 1) متطلبات المالك وقت التنفيذ (من SRS §9)
| المطلوب | ملاحظة |
|---|---|
| VPS | Ubuntu LTS، **≥ 2 vCPU / 4GB RAM / 40GB SSD** (تقدير هندسي؛ الحد الأدنى المطلق 2GB لكن Chromium للـ PDF يحتاج ~1GB وقت الطباعة) |
| دومين + سجل DNS (A) يشير للـ VPS | Caddy يستخرج شهادة HTTPS تلقائياً |
| مستودع GitHub (مُثبَّت عليه تطبيق Claude للدفع) | الفرع الحالي جاهز |
| تخزين خارجي للنسخ (S3-compatible) من **مزود مختلف** | + حساب/مفاتيح محدودة الصلاحية (كتابة فقط للنسخ إن أمكن) |
| مفتاح age خاص (تولّده أنت) | لا يُرسل لأحد ولا يوضع على الخادم |
| بريد/Webhook للتنبيه (اختياري) | فشل النسخ |

مقارنة مختصرة (ADR-002): **VPS + Compose** (موصى به: تحكم كامل وتكلفة ثابتة) مقابل Managed PaaS (جهد أقل لكن حقوق أقل على النسخ وPostgres) مقابل Shared Hosting (**مرفوض**: لا Docker ولا PostgreSQL مضمونان).

## 2) تجهيز الخادم (مرة واحدة)
```bash
# كمستخدم root على Ubuntu LTS جديد
adduser deploy && usermod -aG sudo deploy && rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
# /etc/ssh/sshd_config: PasswordAuthentication no ; PermitRootLogin no  ثم: systemctl restart ssh
apt update && apt -y upgrade && apt -y install ufw fail2ban unattended-upgrades age rclone postgresql-client git curl
ufw default deny incoming && ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
dpkg-reconfigure -plow unattended-upgrades
curl -fsSL https://get.docker.com | sh && usermod -aG docker deploy
```

## 3) نشر التطبيق
```bash
sudo mkdir -p /opt/erp && sudo chown deploy: /opt/erp && cd /opt/erp
git clone <repo-url> . && git checkout <الإصدار المعتمد>
cp .env.example .env && chmod 600 .env && nano .env
```
في `.env` (كلها أسرار عشوائية قوية — `openssl rand -base64 36`):
`DOMAIN` · `POSTGRES_PASSWORD` · `APP_DB_PASSWORD` · `APP_SECRET` · `COOKIE_SECURE=true` · `REQUIRE_OWNER_2FA=true`
```bash
docker compose up -d --build          # db → migrate (يطبّق الترحيلات) → app → caddy
docker compose ps && curl -fsS https://$DOMAIN/api/health
# إنشاء الشركة والمالك (مرة واحدة؛ كلمة المرور من البيئة ولا تُطبع):
docker compose run --rm -e COMPANY_NAME="اسم الشركة" -e OWNER_USERNAME=owner -e OWNER_PASSWORD='<12+ حرفاً وأرقام>' migrate npx tsx scripts/bootstrap.ts
```

## 4) أول دخول (بالترتيب)
1. ادخل كمالك → **الأمان (2FA)**: فعّل المصادقة الثنائية (مطلوبة للعمليات الحساسة).
2. **الشركة**: الاسم والعنوان والهواتف + **الشعار والتوقيع**.
3. **أسعار الصرف**: سعر اليوم (IQD لكل 1 USD).
4. **المستخدمون**: أنشئ المحاسب وراجع صلاحياته (القالب الافتراضي لا يشمل الإلغاء/العكس ولا أي صلاحية «للمالك فقط»).
5. **الأرصدة الافتتاحية**: أدخل النقد/رأس المال/المخزون المؤرخ/العملاء/الموردين؛ يجب أن يظهر «✔ متوازنة» ثم اعتمد (مرة واحدة).
6. **النسخ الاحتياطي**: اتبع `docs/RUNBOOK.md` §2، شغّل `ops/backup.sh daily` يدوياً، ثم **نفّذ اختبار استعادة** وتأكد من ✔ في «سلامة البيانات».
7. **مراقبة خارجية** على `/api/health`.

## 5) بيئة التجربة (Staging) قبل الإنتاج — **إلزامي**
انشر نسخة مستقلة (دومين فرعي، قاعدة منفصلة، بيانات تجريبية) واجتز عليها: دورة شراء ← بيع ← تحصيل ← مصاريف ← تسوية أرباح، وتجربة أوفلاين بجهازين، وطباعة PDF، وبناء الصورة، ونسخ/استعادة. **لا نشر إنتاجي قبل قبولك الصريح.**

## 6) بوابة قبول الإنتاج (Go-Live Checklist)
- [ ] اختبارات CI خضراء على الإصدار (lint، تكامل 136، E2E).
- [ ] Staging اجتازت قائمة §5.
- [ ] نسخة احتياطية ناجحة **واستعادة ناجحة** على قاعدة منفصلة (آخر 7 أيام).
- [ ] 2FA مفعّلة للمالك؛ كلمات مرور قوية؛ `.env` صلاحياته 600 وليس في المستودع.
- [ ] `ufw` يسمح 22/80/443 فقط؛ منفذ 5432 غير مكشوف.
- [ ] الأرصدة الافتتاحية معتمدة ومطابقة لجردك الفعلي (نقد، مخزون، ذمم).
- [ ] أنت (المالك) جرّبت السيناريوهات الأساسية بنفسك ووافقت كتابياً.

## 7) التراجع عن النشر
انظر `docs/RUNBOOK.md` §5. باختصار: نسخة قبل التحديث، ثم `git checkout <السابق> && docker compose up -d --build`، أو استعادة النسخة على قاعدة جديدة عند ترحيل غير متوافق.
