# ⚡ PURPLE | پنل مدیریت VPN

یک پنل مدیریت سبک، زیبا و پرسرعت برای سرورهای VPN با هسته قدرتمند **Sing-box**، طراحی‌شده بر پایه **VLESS (WebSocket & gRPC)** و **Trojan**، ویژه استقرار آسان روی **Railway** و داکر (Docker).

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)
![PURPLE Banner](https://img.shields.io/badge/PURPLE-VPN_Panel_v1.0-a855f7?style=for-the-badge&logo=shield)
![Sing-box](https://img.shields.io/badge/Core-Sing--box_1.8+-c084fc?style=for-the-badge&logo=linux)
![Docker Supported](https://img.shields.io/badge/Deployment-Railway_%2F_Docker-d8b4fe?style=for-the-badge&logo=docker)
![RTL Persian UI](https://img.shields.io/badge/Language-Persian_(RTL)-9333ea?style=for-the-badge)

---

## ✨ ویژگی‌های PURPLE

- 🎨 **طراحی مدرن بنفش (Purple Glassmorphism):**
  - کنتراست بالا، خوانایی کامل متون، پالت بنفش تیره بر پایه اصول طراحی مدرن.
  - ۱۰۰٪ رسپانسیو برای گوشی‌های هوشمند، تبلت و کامپیوتر.
- 🔑 **راه‌اندازی اولیه و امنیت بالا (First-Time Setup Wizard):**
  - تعیین نام کاربری و رمز عبور ادمین در اولین باز کردن پنل قبل از ورود.
  - پنل کاملاً خام و تمیز بدون کاربران نمونه اولیه.
- ⚡ **پشتیبانی از پروتکل‌های متنوع با پینگ واقعی (پورت 443):**
  - **VLESS-WS (WebSocket + TLS)**
  - **VLESS-gRPC (gRPC + TLS)**
  - **Trojan-WS (Trojan WebSocket + TLS)**
  - تمام کانفیگ‌ها بر روی پورت **443 TLS** صادر شده و پینگ سبز واقعی ارائه می‌دهند.
- 🌐 **اسکنر و مدیریت آی‌پی‌های تمیز (Clean IP Scanner):**
  - امکان اعمال آی‌پی/دامنه تمیز اختصاصی روی تمام کانفیگ‌های کاربران با یک کلیک.
- 🤖 **یکپارچه‌سازی با ربات تلگرام (Telegram Bot):**
  - مدیریت تعاملی دکمه‌ای، ارسال لینک ساب و استعلام کاربران در ربات.

---

## 🛠️ راهنمای نصب و استقرار روی Railway

برای راه‌اندازی این پنل روی Railway می‌توانید از ۲ روش ساده استفاده کنید:

### 🔹 روش اول: نصب مستقیم از ریپازیتوری گیت‌هاب (توصیه‌شده و ۱۰۰٪ تضمینی)
1. وارد حساب کاربری خود در **[Railway.com](https://railway.com/)** شوید.
2. روی دکمه **`+ New Project`** در بالای صفحه کلیک کنید.
3. گزینه **`Deploy from GitHub repo`** را انتخاب کنید.
4. ریپازیتوری **`purple-vpn-panel`** را از لیست اکانت گیت‌هاب خود انتخاب نمایید.
5. روی دکمه **`Deploy Now`** کلیک کنید.
6. پس از اتمام ساخت (حدود ۱ دقیقه)، به تب **Settings -> Networking** رفته و روی **`Generate Domain`** کلیک کنید تا آدرس اینترنتی پنل تولید شود.

---

### 🔹 روش دوم: نصب محلی با داکر (Docker & Docker-Compose)
```bash
git clone https://github.com/MohammadMehdiArjmandManesh1386/purple-vpn-panel.git
cd purple-vpn-panel
docker build -t purple-vpn-panel .
docker run -d -p 3000:3000 --name purple-vpn purple-vpn-panel
