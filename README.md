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

The seller reviews orders in the built-in staff console at `/admin.html` (or in
the Supabase dashboard) and flips `status` to `paid` / `delivered`.

---

## 2. Setup

### 2.1 Create the Supabase schema

Open your Supabase project → **SQL Editor** → run the migrations **in order**:

1. [`supabase/migrations/0001_pomelo_orders.sql`](supabase/migrations/0001_pomelo_orders.sql)
2. [`supabase/migrations/0002_pomelo_rbac.sql`](supabase/migrations/0002_pomelo_rbac.sql)

Migration `0001` creates:

| Object | Purpose |
| --- | --- |
| `public.pomelo_orders` | Order rows (RLS: anon may `INSERT` only) |
| `storage.buckets['pomelo-slips']` | Public bucket for transfer slips |
| Storage RLS policies | anon may upload; public may read |

Migration `0002` adds the three-tier RBAC layer:

| Object | Purpose |
| --- | --- |
| `public.profiles` | Staff profiles extending `auth.users` (role: user/admin/owner) |
| `public.pomelo_settings` | PromptPay ID + bank info (public read, owner write) |
| `public.pomelo_catalogue` | Products (public read, admin/owner write) |
| `public.pomelo_page_content` | Editable storefront text (public read, owner write) |
| `public.is_owner()` etc. | `SECURITY DEFINER` role helpers (avoid RLS recursion) |
| `orders_staff_read` / `orders_staff_update` | Staff may read/update orders |

### 2.2 Configure environment variables

```bash
cp .env.example .env.local
```

Fill in:

| Variable | Where to find it | Exposed to browser? |
| --- | --- | --- |
| `SUPABASE_URL` | Settings → API → Project URL | yes (public) |
| `SUPABASE_ANON_KEY` | Settings → API → anon public | yes (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → service_role | **NO — server only** |
| `PROMPTPAY_ID` | your PromptPay account | yes (needed for the QR) |
| `SHOP_NAME` | your shop name | yes |

> The anon key is safe in the browser — it is protected by the RLS policies.
> The **`service_role` key bypasses RLS** and is used only by `/api/admin/*`.
> Never expose it to the browser and never commit it. In Vercel, mark it as a
> *Sensitive* environment variable.

### 2.3 Create the first owner

1. Sign up (or create a user) with the owner's email — either through
   `/login.html` or **Supabase → Authentication → Users → Add user**.
2. Promote that account to `owner` in the SQL Editor:

   ```sql
   update public.profiles
   set role = 'owner'
   where email = 'owner@example.com';
   ```

3. Sign in at `/login.html` → you land on `/admin.html` with full permissions.
   From the **员工与权限** tab the owner can grant `admin` / `user` roles.

### 2.4 Run locally

```bash
npm install
npm run dev        # npx serve . -l 3001 → http://localhost:3001
```

> `npx serve` is a plain static file server: it does **not** execute the
> `/api/*` serverless functions, so `/api/config` returns 404 locally and the
> page shows its "not configured" fallback. To exercise the API + admin console
> locally, use `vercel dev` (requires `vercel login`) or deploy to Vercel.

### 2.5 Deploy to Vercel

```bash
npm run deploy
```

Then add the same environment variables in
**Vercel → Project → Settings → Environment Variables** and redeploy.

---

## 3. Project layout

```
pomelo-shop/
├── index.html                 # Buyer-facing shop
├── login.html                 # Staff sign-in (email + password)
├── admin.html                 # Staff console (role-gated tabs)
├── admin.js                   # Admin console client logic
├── styles.css                 # All CSS
├── app.js                     # Storefront logic (cart, QR, upload, submit)
├── promptpay.js               # Vendored PromptPay payload builder (window.generatePayload)
├── config.js                  # Fetches /api/config → window.POMELO_CONFIG
├── api/
│   ├── config.js              # Public runtime config + catalogue + page text
│   └── admin/
│       ├── _auth.js           # Shared role check (service_role, server-only)
│       ├── me.js              # GET caller identity + role
│       ├── orders.js          # GET list / PATCH update orders
│       ├── catalogue.js       # CRUD products (admin+)
│       ├── content.js         # Page text (owner)
│       ├── settings.js        # PromptPay/bank settings (read: all, write: owner)
│       └── users.js           # Staff roles (owner)
├── supabase/
│   └── migrations/
│       ├── 0001_pomelo_orders.sql
│       └── 0002_pomelo_rbac.sql
├── plans/
│   └── rbac-design.md         # RBAC design notes
├── vercel.json
├── package.json
└── .env.example
```

### Roles

| Role | Orders | Catalogue | Page text | Settings | Staff |
| --- | --- | --- | --- | --- | --- |
| `user` | view + status/note | — | — | view | — |
| `admin` | full edit | full edit | — | view | — |
| `owner` | full edit | full edit | edit | **edit** | manage roles |

Tab visibility in `admin.html` is UX only — every `/api/admin/*` call re-checks
the caller's role server-side with the `service_role` key.

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

## 4. Customising the catalogue & page text

The live catalogue and page text are stored in Supabase and served through
[`api/config.js`](api/config.js), so the owner can edit them in `/admin.html`
**without a redeploy**:

- **Catalogue** → the **商品** tab (admin/owner). Rows live in
  `pomelo_catalogue`; `unit_price` is in **THB**.
- **Page text** → the **页面文字** tab (owner). Keys `hero_title` /
  `hero_subtitle` live in `pomelo_page_content`.

[`app.js`](app.js) keeps a built-in `DEFAULT_CATALOGUE` fallback, used only when
the Supabase read fails (e.g. before migration `0002` is applied). Internally
all money is converted to satang (×100) before being stored, so no
floating-point rounding creeps into totals.

---

## 5. Migrating to a dedicated Supabase project

> **Why?** Pomelo Shop must **not** share a Supabase project with another app
> (e.g. open-play). Both apps create `public.profiles`, both install an
> `on_auth_user_created` trigger, and open-play adds a unique index on
> `lower(email)`. Sharing one project makes the two schemas collide: pomelo's
> `create table if not exists public.profiles` is silently skipped, so
> `role = 'owner'` fails open-play's `CHECK` constraint, and the second account
> with the same email is rejected by the unique index. **Use a separate project.**
>
> **If you already ran `0001` + `0002` in the shared project**, clean them up
> first with [`supabase/cleanup/rollback_pomelo_from_shared.sql`](supabase/cleanup/rollback_pomelo_from_shared.sql).
> That script drops the pomelo-only tables/bucket/functions and **restores
> open-play's shadow-aware `handle_new_user()`**, which pomelo's `0002` had
> overwritten (both apps use the same `on_auth_user_created` trigger name).

The same email address can be reused freely across two *different* projects —
there is no cross-project conflict. No data migration is needed if pomelo has
no production orders yet.

### Step 1 — Create the new project

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Name it e.g. `pomelo-shop`, pick a region close to your users (e.g.
   `Southeast Asia (Singapore)`), set a database password and create it.
3. Wait for provisioning to finish (~2 min).

### Step 2 — Copy the new credentials

**Project → Settings → API**:

| Value | Copy from |
| --- | --- |
| Project URL | *Project URL* |
| anon key | *Project API keys → anon public* |
| service_role key | *Project API keys → service_role* (click *Reveal*) |

### Step 3 — Update local `.env.local`

Replace the three Supabase values (keep `PROMPTPAY_ID` / `SHOP_NAME`):

```bash
SUPABASE_URL=https://<new-ref>.supabase.co
SUPABASE_ANON_KEY=<new-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<new-service-role-key>
```

### Step 4 — Apply the migrations

In the **new** project → **SQL Editor**, run the migrations **in order**:

1. [`supabase/migrations/0001_pomelo_orders.sql`](supabase/migrations/0001_pomelo_orders.sql)
2. [`supabase/migrations/0002_pomelo_rbac.sql`](supabase/migrations/0002_pomelo_rbac.sql)

Both are idempotent (`create table if not exists`, `drop policy if exists`), so
re-running them is safe.

### Step 5 — Create the owner account

1. **Authentication → Users → Add user** → enter the owner email + password →
   tick **Auto Confirm User**.
2. The `on_auth_user_created` trigger inserts a matching `public.profiles` row
   with `role = 'user'`.
3. Promote it in the SQL Editor:

   ```sql
   update public.profiles
   set role = 'owner'
   where email = 'owner@example.com';
   ```

4. Sign in at `/login.html` → you land on `/admin.html` with full permissions.

### Step 6 — Update Vercel

**Vercel → Project → Settings → Environment Variables** → set the same three
Supabase values (mark `SUPABASE_SERVICE_ROLE_KEY` as **Sensitive**) → **Redeploy**.

### Step 7 — Verify

- `GET /api/config` returns the new `supabaseUrl` and a populated `catalogue`.
- `/login.html` signs in and `/admin.html` shows the owner's tabs.
- A test order inserts into the new project's `pomelo_orders`.

> **Optional:** if you want to carry over existing test orders, export them from
> the old project (Table Editor → `pomelo_orders` → **Export CSV**) and import
> into the new one. Slips live in the old `pomelo-slips` bucket and would need
> re-uploading; for test data it is usually simpler to start clean.

---

## 6. Security notes

- Buyers can **insert** orders but cannot **read** them back — the order id is
  not treated as a secret, so a `SELECT` policy would leak every buyer's phone
  number and slip. Staff read orders through `/api/admin/orders`.
- The `service_role` key is used **only** inside `/api/admin/*`. It is never
  sent to the browser. Every admin endpoint verifies the caller's Supabase
  access token and re-loads their role from `profiles` before acting.
- `pomelo_settings` (PromptPay ID, bank info) is **public-read** because the
  storefront must build the QR client-side; only the **owner** may write it.
- The `pomelo-slips` bucket is public-read so the seller can open slip URLs
  directly. If you want slips private, flip the bucket to private and serve
  them through signed URLs from an admin function.
- Uploads are capped at 8 MB and restricted to image MIME types.
