# ZEXO design notes (from the reference video)

Mobile-first dark Minecraft UI. Portrait phone layout, max width 480px.

## Colours
- Background #16181a, cards #202325 / #292d30, edge #0c0d0e
- Primary green #5fd04a (dark edge #2f7d25), text #ffffff, muted #9aa3a8
- Accent tiles: blue #2f6fb5, red #c93a52, amber #d9902b, purple #7a4fc9, teal #1f9e8f

## Type
- Headings and buttons: Pixelify Sans (pixel look), fallback Courier New
- Body: Nunito 600/800

## Components
- Pixel bevel: 2px dark outline + inset bottom shadow (cards, buttons, tiles)
- Primary button: green, dark-green bottom edge, presses down 2px
- Bottom nav: 5 tabs (Home, Catalog, Character, Shop, More); active tab is a raised green tile
- Chips for filters, bottom sheets for details and account
- Skin viewer: CSS 3D blocky character with Standing / Walking / Waving poses
- Admin dashboard: separate desktop layout, black background, green accents, left sidebar, data tables

## Sections
Home = texture packs only. Catalog = add-ons only. Character = skins. Shop = coins and digital products. More = account, saved, help, contact, privacy, terms, about.
