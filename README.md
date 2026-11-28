# ZEXO (Cloudflare only)

Stack: Cloudflare Pages/Workers, D1 (database zexo-db), R2 (bucket zexo-files).

## Folders
- src/index.ts - API source (auth, admin, uploads, downloads, shop)
- public/ - user site (index.html) and admin dashboard (admin/index.html)
- migrations/ - D1 schema (already applied to your database)
- pages-upload-ready/ - compiled bundle (_worker.js + pages) to upload in the dashboard
- wrangler.jsonc - config for npx wrangler deploy

## Option A: phone/dashboard (no tools)
1. Workers & Pages > Create application > Pages > Upload assets.
2. Upload the contents of pages-upload-ready/ (or zip it first).
3. Settings > Bindings: D1 DB = zexo-db, R2 FILES = zexo-files.
4. Settings > Variables and Secrets: secret ADMIN_SETUP_TOKEN = a long random value.
5. Redeploy. Open /admin/ > First-time setup to create the admin.

## Option B: Wrangler
    npx wrangler secret put ADMIN_SETUP_TOKEN
    npx wrangler deploy

## Notes
- Uploads: .mcaddon .mcpack .mcworld .zip up to 50 MB, ZIP signature checked. Thumbnails PNG/JPG/WebP up to 2 MB.
- Coin packs need a payment provider (not connected). Digital products are bought with coins.
- Admin is desktop-first; use Desktop site on a phone.
- Not built yet: Reports, Website Settings, skin management screens.
