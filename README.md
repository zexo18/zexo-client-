# ZEXO Website

ZEXO Minecraft digital-content platform.

## Stack
Cloudflare Pages/Workers, D1 and R2.

## Folders
- src/index.ts — API (auth, admin, uploads, downloads, shop)
- public/ — user site and admin dashboard
- migrations/ — D1 schema
- pages-upload-ready/ — compiled Pages bundle
- wrangler.jsonc — Cloudflare deployment config

## Features
- Texture packs
- Add-ons
- Character skins
- ZEXO Coins and digital products
- User accounts and saved content
- Admin desktop dashboard
- Minecraft package uploads

## Deployment
Set the ADMIN_SETUP_TOKEN secret in Cloudflare/Wrangler before first-time admin setup.

See the Cloudflare deployment notes in this repository for the required D1 and R2 bindings.
