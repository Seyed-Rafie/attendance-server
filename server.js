# Attendance Server

QR پویا + بیومتریک + بایند دستگاه.

## Local

```bash
npm install
npm start
```

سرور روی `http://localhost:3000` بالا می‌آید. توکن‌ها در `tokens.json` ذخیره می‌شوند.

## Deploy — Fly.io

```bash
fly auth login
fly launch --copy-config
fly volumes create attendance_data --size 1
fly deploy
```

URL نهایی: `https://<app>.fly.dev`

## Deploy — Railway

1. ریپو را در GitHub پوش کن.
2. در Railway: New Project → Deploy from GitHub.
3. Variables:
   - `PORT=3000`
   - `CORS_ORIGIN=https://<app>.up.railway.app`
   - `DB_FILE=/data/attendance.db`
4. Volume به مسیر `/data` وصل کن.
5. Deploy.

## Env Vars

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PORT` | `3000` | پورت سرور |
| `DB_FILE` | `./attendance.db` | مسیر دیتابیس |
| `CORS_ORIGIN` | `*` | دامنه‌ی مجاز |
| `QR_STEP_SECONDS` | `10` | بازه‌ی QR |
| `QR_TOLERANCE_SECONDS` | `8` | ارفاق انقضا |
| `EXP_GRACE_SECONDS` | `3` | ارفاق تأخیر شبکه |
| `SEED_ON_EMPTY` | `true` | ساخت داده‌ی نمونه |

## API

- `GET /health`
- `POST /api/session/start` (teacher)
- `GET  /api/session/:sid/qr` (teacher)
- `POST /api/session/:sid/close` (teacher)
- `POST /api/attendance/scan` (student)
- `GET  /api/session/:sid/report` (teacher)