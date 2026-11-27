-- ZEXO schema. Files live in R2; only their keys are stored here.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('texturepack','addon','mod')),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  mc_version TEXT NOT NULL DEFAULT '',
  creator TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',
  thumbnail_key TEXT,
  file_key TEXT,
  file_name TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_content_kind_status ON content(kind, status, created_at);
CREATE TABLE IF NOT EXISTS skins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  colors_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  popularity INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('coin_pack','digital')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  coins_granted INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  price_coins INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  coins_delta INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS saved (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, content_id)
);