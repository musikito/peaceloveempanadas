# Empanadas shop

A storefront and admin panel for selling empanadas for delivery or pickup.

- **Customers:** see the menu (photo, price, quantity), choose delivery or pickup and a time slot, enter an address, and pay with card, Apple Pay, Google Pay or Cash App Pay through Stripe Checkout.
- **Admins (2 people):** sales for today, this week, this month and this year; a 30-day chart; best sellers; an order queue with status updates; menu editing with photo uploads; and all shop settings (fees, ZIP codes, hours, slot capacity, alert phones).
- **Alerts:** each paid order sends an SMS through Twilio to the numbers in Settings.

Stack: Next.js 15 on **Vercel**, **Supabase** (Postgres, Auth, Storage), **Stripe**, **Twilio**.

---

## Setup (about 30 minutes)

### 1. Supabase
1. Create a project at supabase.com.
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, and run it.
3. Go to **Authentication → Sign In / Providers → Email** and turn off **Allow new users to sign up**. Only the accounts you create can log in.
4. Go to **Authentication → Users → Add user** and create both admin accounts (email + strong password).
5. Back in the SQL Editor, run this once for each admin:
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
6. Copy the values from **Project Settings → API**: Project URL, `anon` key, `service_role` key.

### 2. Stripe
1. Under **Settings → Payment methods**, turn on Cards, Apple Pay, Google Pay and **Cash App Pay**. The checkout shows every method you enable here.
2. Copy your secret key from **Developers → API keys**. Use `sk_test_…` until you've tested end to end.
3. You'll create the webhook after deploying (step 4).

### 3. Twilio
1. Buy a phone number (or create a Messaging Service).
2. **US numbers must be A2P 10DLC registered** before texts are delivered reliably. Start this early, because approval can take days.
3. Copy the Account SID, Auth Token, and the number (`+1…`) or Messaging Service SID (`MG…`).

### 4. Deploy to Vercel
1. Push this folder to a GitHub repo (`.env` is git-ignored).
2. In Vercel, choose **Add New → Project**, import the repo, and add every variable from `.env.example`. Set `NEXT_PUBLIC_SITE_URL` to your real domain, for example `https://empanadas.com`.
3. Deploy.
4. In Stripe, go to **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-DOMAIN/api/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`
   - Copy the signing secret (`whsec_…`) into Vercel as `STRIPE_WEBHOOK_SECRET`, then redeploy.

### 5. First run
1. Go to `https://YOUR-DOMAIN/admin` and sign in.
2. In **Settings**, set the pickup address, delivery fee and ZIP codes, hours, slot length, orders per slot, and alert phones. Click **Send a test text**.
3. In **Menu**, add your empanadas with photos.
4. Place a test order using card `4242 4242 4242 4242`, any future date, and any CVC. Confirm the text arrives and the order shows under **Orders**.
5. Switch to live Stripe keys and a live webhook secret.

### Run locally
```bash
cp .env.example .env.local   # fill in values
npm install
npm run dev
# in another terminal, forward webhooks:
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

---

## Security (red-team notes)

| Attack | Defense |
|---|---|
| Edit the cart price or total in the browser | The server ignores browser prices. It reloads each product from the database, recomputes the subtotal, fee and total, and sends only those amounts to Stripe. |
| Open `/order/success` without paying | Nothing is marked paid there. Only the **signature-verified Stripe webhook** sets `paid`, and only if Stripe's `amount_total` equals the stored total. |
| Replay or retry webhooks | The status update is conditional (`pending → paid`), so a retry can't create a second order or send a second SMS. |
| Book more orders than a slot allows | `create_pending_order` locks the slot in Postgres (advisory lock) before counting, so two simultaneous checkouts can't both take the last spot. |
| Pick a time outside business hours | The submitted slot must exactly match a slot the server is currently offering (hours, lead time, alignment). |
| Read orders or customer data with the public anon key | RLS is on for every table. Anonymous users get **no** policies. Admin tables require `is_admin()`. |
| Call admin server actions directly | Every action re-checks `requireAdmin()`, and writes run as the logged-in user, so RLS checks them a second time. |
| Upload a malicious file as a "photo" | The file type is detected from its actual bytes (JPG/PNG/WebP only, ≤5 MB), the file gets a random name, and the bucket also restricts MIME types. SVG/HTML is impossible. |
| Spam checkout or hold all the slots | Checkout is limited to 10 attempts per IP per 10 minutes (stored in Postgres, so it works on serverless). Unpaid holds expire after about 31 minutes. |
| Cross-site checkout requests, clickjacking | In production, checkout rejects requests from other origins. CSP, `X-Frame-Options: DENY`, HSTS and nosniff headers are set. |
| Leak secrets to the browser | Service-role, Stripe and Twilio keys live only in `server-only` modules, and the build fails if a client component imports them. Alert phone numbers are never sent to the storefront. |
| Brute-force the admin login | Supabase Auth rate-limits sign-ins. The login error doesn't reveal whether an email exists. Signups are disabled. |

**Remaining risks and recommendations:**
- **Admin login:** turn on MFA (TOTP) for both accounts in Supabase. Use unique passwords stored in a password manager.
- **Slot holding:** someone using many IPs could still hold slots for up to 31 minutes. If that happens, add a Vercel Firewall rate-limit rule on `/api/checkout`, or add a CAPTCHA (Cloudflare Turnstile) to checkout.
- **Inline scripts in the CSP:** the CSP allows `'unsafe-inline'` scripts because Next.js needs them without nonces. All user text is rendered through React, which escapes it.
- **Refunds:** issue them in the Stripe Dashboard, then mark the order **Cancelled** so it drops out of the sales totals.
- **Key rotation:** if a key ever leaks, rotate the Supabase service-role key, the Stripe keys and the Twilio token, then update them in Vercel.

## Files
```
supabase/schema.sql             tables, RLS, slot locking, rate limit, sales reports, storage bucket
app/page.tsx, app/shop.tsx      storefront
app/api/checkout/route.ts       validates order, reserves slot, creates Stripe Checkout
app/api/stripe/webhook/route.ts marks orders paid, sends Twilio SMS
app/order/success/              confirmation page
app/admin/login/                admin sign-in
app/admin/(panel)/              sales dashboard, orders, menu, settings, server actions
middleware.ts                   admin session refresh and redirect
lib/                            Supabase, Stripe, Twilio, slots, rate limiting
```
