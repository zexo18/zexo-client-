CREATE TABLE IF NOT EXISTS coin_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
-- Seed skins and coin packs live in D1 already; add more from the admin dashboard.
