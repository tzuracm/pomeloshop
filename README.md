# 🍊 Pomelo Shop

A deliberately tiny, no-registration ordering page for selling pomelo (柚子)
through WeChat groups. Buyers open a link, fill in their name + phone, pick a
spec, scan a **PromptPay** QR, upload their transfer slip, and submit. No
accounts, no login, no app.

- **Hosting:** [Vercel](https://vercel.com) (static site)
- **Database + Storage:** [Supabase](https://supabase.com)
- **Payment:** PromptPay dynamic QR generated entirely in the browser

---

## 1. How it works

```
Buyer's phone                          Supabase
─────────────                          ────────
1. Fill name / phone  ──┐
   (saved to localStorage)
2. Pick spec  ──────────┤
3. PromptPay QR updates │  (pure client-side, no network)
   with the total       │
4. Scan + pay           │
5. Upload slip  ────────┼──►  storage: pomelo-slips/<orderId>/slip.jpg
                        │         │
                        │         └─► public URL
6. Submit order  ───────┴──►  table: pomelo_orders (status = 'pending')
```

The seller reviews orders in the Supabase dashboard (or any admin UI built on
top of it) and flips `status` to `paid` / `delivered`.

---

## 2. Setup

### 2.1 Create the Supabase schema

Open your Supabase project → **SQL Editor** → paste the contents of
[`supabase/migrations/0001_pomelo_orders.sql`](supabase/migrations/0001_pomelo_orders.sql)
→ **Run**.

This creates:

| Object | Purpose |
| --- | --- |
| `public.pomelo_orders` | Order rows (RLS: anon may `INSERT` only) |
| `storage.buckets['pomelo-slips']` | Public bucket for transfer slips |
| Storage RLS policies | anon may upload; public may read |

### 2.2 Configure environment variables

```bash
cp .env.example .env
```

Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `PROMPTPAY_ID`.

> The anon key is safe in the browser — it is protected by the RLS policies.
> **Never** put the `service_role` key in this project.

### 2.3 Run locally

```bash
npm install
npm run dev        # vercel dev → http://localhost:3000
```

### 2.4 Deploy to Vercel

```bash
npm run deploy
```

Then add the same environment variables in
**Vercel → Project → Settings → Environment Variables** and redeploy.

---

## 3. Project layout

```
pomelo-shop/
├── index.html                 # Markup for the whole shop
├── styles.css                 # All CSS
├── app.js                     # All client logic (cart, QR, upload, submit)
├── promptpay.js               # Vendored PromptPay payload builder (window.generatePayload)
├── config.js                  # Fetches /api/config → window.POMELO_CONFIG
├── api/
│   └── config.js              # Vercel function: serves runtime env to the page
├── supabase/
│   └── migrations/
│       └── 0001_pomelo_orders.sql
├── vercel.json
├── package.json
└── .env.example
```

> **Note on `promptpay.js`:** the `promptpay-qr` npm package is CommonJS-only
> and has no browser bundle on any CDN. Rather than add a bundler, the ~60-line
> algorithm (EMVCo TLV + CRC16-XMODEM) is vendored into
> [`promptpay.js`](promptpay.js). Its output is byte-identical to
> `promptpay-qr@0.5.0` — verified against the original across mobile-number,
> national-ID and e-Wallet targets.

### Why `api/config.js`?

Vercel serves static files as-is, so `index.html` cannot read `process.env`.
The tiny serverless function at [`api/config.js`](api/config.js) returns the
public config (Supabase URL, anon key, PromptPay ID, shop name) as JSON, and
[`config.js`](config.js) fetches it before the page boots. This keeps secrets
out of the repo while still allowing a fully static front end.

---

## 4. Customising the catalogue

Edit the `CATALOGUE` array at the top of the `<script>` block in
[`index.html`](index.html):

```js
const CATALOGUE = [
  { sku: '5kg',  label: '5 kg 装',  unitPrice: 180, unit: 'THB' },
  { sku: '10kg', label: '10 kg 装', unitPrice: 330, unit: 'THB' },
];
```

`unitPrice` is in **THB**. Internally everything is converted to satang
(×100) before being stored, so no floating-point rounding creeps into totals.

---

## 5. Security notes

- Buyers can **insert** orders but cannot **read** them back — the order id is
  not treated as a secret, so a `SELECT` policy would leak every buyer's phone
  number and slip.
- The `pomelo-slips` bucket is public-read so the seller can open slip URLs
  directly. If you want slips private, flip the bucket to private and serve
  them through signed URLs from an admin function.
- Uploads are capped at 8 MB and restricted to image MIME types.
