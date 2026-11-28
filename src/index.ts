// src/index.ts: ZEXO stage 2 API (auth, admin, content, uploads, downloads)
// Static pages come from Workers Static Assets; only /api/* runs here.

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES: R2Bucket;
  ADMIN_SETUP_TOKEN?: string; // secret, used once to create the first admin
}

type Kind = "texturepack" | "addon" | "mod";
type User = { id: number; email: string; display_name: string; role: "user" | "admin"; coins: number };

const MAX_FILE = 50 * 1024 * 1024; // 50 MB: formData() buffers in Worker memory
const MAX_THUMB = 2 * 1024 * 1024;
const FILE_EXT: Record<Kind, string[]> = {
  texturepack: ["mcpack", "zip", "mcaddon"],
  addon: ["mcaddon", "mcpack", "zip"],
  mod: ["mcaddon", "mcpack", "mcworld", "zip"],
};
const KINDS = Object.keys(FILE_EXT) as Kind[];
const COOKIE = "zexo_session";
const DAY = 86400;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers } });

/* ---------- crypto ---------- */
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function pbkdf2(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

/* ---------- auth ---------- */
const cookieOf = (req: Request, name: string) => req.headers.get("Cookie")?.split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);
async function currentUser(req: Request, env: Env): Promise<User | null> {
  const t = cookieOf(req, COOKIE);
  if (!t) return null;
  return env.DB.prepare(
    `SELECT u.id,u.email,u.display_name,u.role,u.coins FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>datetime('now')`,
  ).bind(await sha256(t)).first<User>();
}
async function startSession(env: Env, userId: number): Promise<string> {
  const token = rand(32);
  await env.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+30 days'))`).bind(await sha256(token), userId).run();
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * DAY}`;
}
async function body<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, "Send a valid JSON body."); }
}
const validEmail = (e: string) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);

async function createUser(env: Env, email: string, password: string, name: string, role: "user" | "admin") {
  email = String(email || "").trim().toLowerCase();
  name = String(name || "").trim().slice(0, 40) || email.split("@")[0];
  if (!validEmail(email)) throw new HttpError(400, "Enter a valid email address.");
  if (String(password || "").length < 10) throw new HttpError(400, "Password must be at least 10 characters.");
  const salt = rand(16);
  try {
    const r = await env.DB.prepare(`INSERT INTO users(email,display_name,password_hash,salt,role) VALUES(?,?,?,?,?)`)
      .bind(email, name, await pbkdf2(password, salt), salt, role).run();
    return r.meta.last_row_id as number;
  } catch {
    throw new HttpError(409, "An account with this email already exists.");
  }
}

/* ---------- file checks ---------- */
const ext = (n: string) => n.split(".").pop()?.toLowerCase() ?? "";
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "item";
async function head(f: File, n = 12) { return new Uint8Array(await f.slice(0, n).arrayBuffer()); }
async function checkPackage(kind: Kind, f: File) {
  if (!FILE_EXT[kind].includes(ext(f.name))) throw new HttpError(400, `Unsupported file type. Allowed for ${kind}: ${FILE_EXT[kind].map((e) => "." + e).join(", ")}.`);
  if (f.size === 0 || f.size > MAX_FILE) throw new HttpError(413, "File must be between 1 byte and 50 MB.");
  const h = await head(f, 4); // every allowed type is a ZIP container
  if (!(h[0] === 0x50 && h[1] === 0x4b && (h[2] === 3 || h[2] === 5))) throw new HttpError(400, "This file is not a valid Minecraft package (not a ZIP container).");
}
async function checkThumb(f: File): Promise<string> {
  if (f.size === 0 || f.size > MAX_THUMB) throw new HttpError(413, "Thumbnail must be under 2 MB.");
  const h = await head(f, 12);
  if (h[0] === 0x89 && h[1] === 0x50) return "image/png";
  if (h[0] === 0xff && h[1] === 0xd8) return "image/jpeg";
  if (h[0] === 0x52 && h[1] === 0x49 && h[8] === 0x57) return "image/webp";
  throw new HttpError(400, "Thumbnail must be a PNG, JPG or WebP image.");
}

/* ---------- content ---------- */
const text = (fd: FormData, k: string, max = 500) => String(fd.get(k) ?? "").trim().slice(0, max);
const publicCols = `id,kind,slug,name,description,category,version,mc_version,creator,resolution,file_size,downloads,created_at,(thumbnail_key IS NOT NULL) AS has_thumb`;

async function saveContent(env: Env, req: Request, id: number | null): Promise<Response> {
  const fd = await req.formData();
  const kind = text(fd, "kind") as Kind;
  const name = text(fd, "name", 80);
  const existing = id ? await env.DB.prepare(`SELECT * FROM content WHERE id=?`).bind(id).first<any>() : null;
  if (id && !existing) throw new HttpError(404, "Item not found.");
  const k = existing?.kind ?? kind;
  if (!KINDS.includes(k)) throw new HttpError(400, "Choose a content type.");
  if (!name) throw new HttpError(400, "Name is required.");
  const file = fd.get("file"), thumb = fd.get("thumbnail");
  const hasFile = file instanceof File && file.size > 0, hasThumb = thumb instanceof File && thumb.size > 0;
  if (!existing && !hasFile) throw new HttpError(400, "Choose a package file to upload.");
  if (hasFile) await checkPackage(k, file as File);
  const thumbType = hasThumb ? await checkThumb(thumb as File) : "";

  const key = (p: string) => `${p}/${rand(12)}`;
  let fileKey = existing?.file_key ?? null, fileName = existing?.file_name ?? null, fileSize = existing?.file_size ?? 0, thumbKey = existing?.thumbnail_key ?? null;
  const oldKeys: string[] = [];
  if (hasFile) {
    if (fileKey) oldKeys.push(fileKey);
    fileKey = key("pkg"); fileName = (file as File).name.slice(0, 120); fileSize = (file as File).size;
    await env.FILES.put(fileKey, (file as File).stream(), { httpMetadata: { contentType: "application/octet-stream" } });
  }
  if (hasThumb) {
    if (thumbKey) oldKeys.push(thumbKey);
    thumbKey = key("img");
    await env.FILES.put(thumbKey, (thumb as File).stream(), { httpMetadata: { contentType: thumbType } });
  }
  const f = { description: text(fd, "description", 2000), category: text(fd, "category", 40), version: text(fd, "version", 20), mc: text(fd, "mc_version", 30), creator: text(fd, "creator", 60), res: text(fd, "resolution", 10) };
  const status = text(fd, "status") === "published" && fileKey ? "published" : existing ? existing.status : "draft";
  if (existing) {
    await env.DB.prepare(`UPDATE content SET name=?,description=?,category=?,version=?,mc_version=?,creator=?,resolution=?,file_key=?,file_name=?,file_size=?,thumbnail_key=?,status=?,updated_at=datetime('now') WHERE id=?`)
      .bind(name, f.description, f.category, f.version, f.mc, f.creator, f.res, fileKey, fileName, fileSize, thumbKey, status, id).run();
  } else {
    const r = await env.DB.prepare(`INSERT INTO content(kind,slug,name,description,category,version,mc_version,creator,resolution,file_key,file_name,file_size,thumbnail_key,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(k, `${slugify(name)}-${rand(3)}`, name, f.description, f.category, f.version, f.mc, f.creator, f.res, fileKey, fileName, fileSize, thumbKey, status).run();
    id = r.meta.last_row_id as number;
  }
  if (oldKeys.length) await env.FILES.delete(oldKeys); // only after the DB update succeeded
  return json({ ok: true, id, status });
}

/* ---------- router ---------- */
async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname, m = req.method;
  if (m !== "GET" && m !== "HEAD" && req.headers.get("X-Requested-With") !== "zexo") throw new HttpError(403, "Missing request header.");
  const user = await currentUser(req, env);
  const parts = path.split("/").filter(Boolean).slice(1); // drop "api"

  if (path === "/api/health") return json({ ok: true });

  /* auth */
  if (path === "/api/auth/register" && m === "POST") {
    const b = await body<any>(req);
    const id = await createUser(env, b.email, b.password, b.name, "user");
    return json({ ok: true }, 201, { "Set-Cookie": await startSession(env, id) });
  }
  if (path === "/api/auth/login" && m === "POST") {
    const b = await body<any>(req);
    const row = await env.DB.prepare(`SELECT id,password_hash,salt FROM users WHERE email=?`).bind(String(b.email || "").trim().toLowerCase()).first<any>();
    // always hash, so timing doesn't reveal whether the email exists
    const h = await pbkdf2(String(b.password || ""), row?.salt ?? "0".repeat(32));
    if (!row || !same(h, row.password_hash)) throw new HttpError(401, "Email or password is incorrect.");
    return json({ ok: true }, 200, { "Set-Cookie": await startSession(env, row.id) });
  }
  if (path === "/api/auth/logout" && m === "POST") {
    const t = cookieOf(req, COOKIE);
    if (t) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash=?`).bind(await sha256(t)).run();
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
  }
  if (path === "/api/me" && m === "GET") return json({ user });
  if (path === "/api/admin/bootstrap" && m === "POST") {
    const b = await body<any>(req);
    const setup = env.ADMIN_SETUP_TOKEN;
    const any = await env.DB.prepare(`SELECT 1 AS x FROM users WHERE role='admin' LIMIT 1`).first();
    if (!setup || any || !same(String(b.token || ""), setup)) throw new HttpError(403, "Admin setup is not available.");
    const id = await createUser(env, b.email, b.password, b.name, "admin");
    return json({ ok: true }, 201, { "Set-Cookie": await startSession(env, id) });
  }

  /* public content */
  if (path === "/api/content" && m === "GET") {
    const kind = url.searchParams.get("kind") as Kind;
    const q = (url.searchParams.get("q") ?? "").slice(0, 60);
    if (!KINDS.includes(kind)) throw new HttpError(400, "Unknown content type.");
    const r = await env.DB.prepare(`SELECT ${publicCols} FROM content WHERE kind=? AND status='published' AND name LIKE ? ORDER BY created_at DESC LIMIT 100`).bind(kind, `%${q.replace(/[%_]/g, "")}%`).all();
    return json({ items: r.results });
  }
  if (parts[0] === "thumb" && m === "GET") {
    const row = await env.DB.prepare(`SELECT thumbnail_key,status FROM content WHERE id=?`).bind(Number(parts[1])).first<any>();
    if (!row?.thumbnail_key || (row.status !== "published" && user?.role !== "admin")) throw new HttpError(404, "Not found.");
    const o = await env.FILES.get(row.thumbnail_key);
    if (!o) throw new HttpError(404, "Not found.");
    return new Response(o.body, { headers: { "Content-Type": o.httpMetadata?.contentType ?? "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  }
  if (parts[0] === "download" && m === "GET") {
    const row = await env.DB.prepare(`SELECT id,file_key,file_name,status FROM content WHERE id=?`).bind(Number(parts[1])).first<any>();
    if (!row?.file_key || (row.status !== "published" && user?.role !== "admin")) throw new HttpError(404, "Not found.");
    const o = await env.FILES.get(row.file_key);
    if (!o) throw new HttpError(404, "The file is missing from storage.");
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO downloads(user_id,content_id) VALUES(?,?)`).bind(user?.id ?? null, row.id),
      env.DB.prepare(`UPDATE content SET downloads=downloads+1 WHERE id=?`).bind(row.id),
    ]);
    const safe = String(row.file_name).replace(/[^\w.\- ]/g, "_");
    return new Response(o.body, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${safe}"`, "Content-Length": String(o.size), "Cache-Control": "no-store" } });
  }

  /* public skins + shop */
  if (path === "/api/skins" && m === "GET") {
    const r = await env.DB.prepare(`SELECT id,name,colors_json,popularity,created_at FROM skins WHERE status='published' ORDER BY popularity DESC`).all<any>();
    return json({ items: r.results.map((x) => ({ id: x.id, name: x.name, popularity: x.popularity, created_at: x.created_at, colors: JSON.parse(x.colors_json) })) });
  }
  if (path === "/api/products" && m === "GET") {
    return json({ items: (await env.DB.prepare(`SELECT id,kind,name,description,coins_granted,price_cents,price_coins FROM products WHERE active=1 ORDER BY kind,id`).all()).results });
  }

  /* signed-in user features */
  if (parts[0] === "me" && parts[1] === "overview" && m === "GET") {
    if (!user) throw new HttpError(401, "Sign in required.");
    const [d, p, sv] = await Promise.all([
      env.DB.prepare(`SELECT d.created_at,c.id,c.name FROM downloads d JOIN content c ON c.id=d.content_id WHERE d.user_id=? ORDER BY d.id DESC LIMIT 50`).bind(user.id).all(),
      env.DB.prepare(`SELECT p.created_at,p.coins_delta,p.status,pr.name FROM purchases p JOIN products pr ON pr.id=p.product_id WHERE p.user_id=? ORDER BY p.id DESC LIMIT 50`).bind(user.id).all(),
      env.DB.prepare(`SELECT c.id,c.name,c.kind FROM saved s JOIN content c ON c.id=s.content_id WHERE s.user_id=? AND c.status='published'`).bind(user.id).all(),
    ]);
    return json({ downloads: d.results, purchases: p.results, saved: sv.results });
  }
  if (parts[0] === "saved" && (m === "POST" || m === "DELETE")) {
    if (!user) throw new HttpError(401, "Sign in required.");
    const cid = Number(parts[1]);
    if (!Number.isInteger(cid)) throw new HttpError(400, "Bad id.");
    if (m === "POST") {
      const ok = await env.DB.prepare(`SELECT 1 AS x FROM content WHERE id=? AND status='published'`).bind(cid).first();
      if (!ok) throw new HttpError(404, "Not found.");
      await env.DB.prepare(`INSERT OR IGNORE INTO saved(user_id,content_id) VALUES(?,?)`).bind(user.id, cid).run();
    } else await env.DB.prepare(`DELETE FROM saved WHERE user_id=? AND content_id=?`).bind(user.id, cid).run();
    return json({ ok: true });
  }
  if (path === "/api/shop/buy" && m === "POST") {
    if (!user) throw new HttpError(401, "Sign in to buy.");
    const b = await body<{ product_id: number }>(req);
    const pr = await env.DB.prepare(`SELECT id,kind,price_coins FROM products WHERE id=? AND active=1`).bind(Number(b.product_id)).first<any>();
    if (!pr) throw new HttpError(404, "Product not found.");
    // Real money is never simulated: coin packs need a payment provider that is not connected yet.
    if (pr.kind === "coin_pack") throw new HttpError(501, "Card payments are not connected yet, so coin packs can't be bought.");
    if (pr.price_coins <= 0) throw new HttpError(400, "This product has no coin price.");
    const spent = await env.DB.prepare(`UPDATE users SET coins=coins-? WHERE id=? AND coins>=?`).bind(pr.price_coins, user.id, pr.price_coins).run();
    if (!spent.meta.changes) throw new HttpError(402, "Not enough ZEXO Coins.");
    try {
      await env.DB.prepare(`INSERT INTO purchases(user_id,product_id,coins_delta,status) VALUES(?,?,?,'completed')`).bind(user.id, pr.id, -pr.price_coins).run();
    } catch (e) {
      await env.DB.prepare(`UPDATE users SET coins=coins+? WHERE id=?`).bind(pr.price_coins, user.id).run(); // refund
      throw e;
    }
    return json({ ok: true });
  }

  /* admin only: authentication AND authorization are checked on every route */
  if (parts[0] === "admin") {
    if (!user) throw new HttpError(401, "Sign in required.");
    if (user.role !== "admin") throw new HttpError(403, "Administrator access required.");
    const sub = parts[1];
    if (sub === "products") {
      const num = (v: unknown, max = 1e9) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
      if (m === "GET") return json({ items: (await env.DB.prepare(`SELECT * FROM products ORDER BY id DESC`).all()).results });
      const b = m === "DELETE" ? ({} as any) : await body<any>(req);
      if (m === "POST" || m === "PUT") {
        const kind = b.kind === "coin_pack" ? "coin_pack" : "digital", name = String(b.name || "").trim().slice(0, 80);
        if (!name) throw new HttpError(400, "Product name is required.");
        const v = [kind, name, String(b.description || "").slice(0, 500), num(b.coins_granted), num(b.price_cents), num(b.price_coins), b.active === false ? 0 : 1];
        if (m === "POST") await env.DB.prepare(`INSERT INTO products(kind,name,description,coins_granted,price_cents,price_coins,active) VALUES(?,?,?,?,?,?,?)`).bind(...v).run();
        else await env.DB.prepare(`UPDATE products SET kind=?,name=?,description=?,coins_granted=?,price_cents=?,price_coins=?,active=? WHERE id=?`).bind(...v, Number(parts[2])).run();
        return json({ ok: true });
      }
      if (m === "DELETE") {
        try { await env.DB.prepare(`DELETE FROM products WHERE id=?`).bind(Number(parts[2])).run(); }
        catch { throw new HttpError(409, "This product has purchases. Deactivate it instead."); }
        return json({ ok: true });
      }
    }
    if (sub === "coins") {
      if (m === "GET") return json({ items: (await env.DB.prepare(`SELECT l.created_at,l.delta,l.reason,u.email FROM coin_ledger l JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 100`).all()).results });
      if (m === "POST") {
        const b = await body<any>(req), delta = Math.trunc(Number(b.delta));
        if (!delta || Math.abs(delta) > 1e7) throw new HttpError(400, "Enter a non-zero coin amount.");
        const u = await env.DB.prepare(`SELECT id,coins FROM users WHERE email=?`).bind(String(b.email || "").trim().toLowerCase()).first<any>();
        if (!u) throw new HttpError(404, "No user with that email.");
        const r = await env.DB.prepare(`UPDATE users SET coins=coins+? WHERE id=? AND coins+?>=0`).bind(delta, u.id, delta).run();
        if (!r.meta.changes) throw new HttpError(400, "That would make the balance negative.");
        await env.DB.prepare(`INSERT INTO coin_ledger(user_id,delta,reason) VALUES(?,?,?)`).bind(u.id, delta, String(b.reason || "").slice(0, 120)).run();
        return json({ ok: true, balance: u.coins + delta });
      }
    }
    if (sub === "stats" && m === "GET") {
      const q = (s: string) => env.DB.prepare(s).first<{ n: number }>().then((r) => r?.n ?? 0);
      return json({
        users: await q(`SELECT COUNT(*) n FROM users`), published: await q(`SELECT COUNT(*) n FROM content WHERE status='published'`),
        drafts: await q(`SELECT COUNT(*) n FROM content WHERE status='draft'`), downloads: await q(`SELECT COUNT(*) n FROM downloads`),
        storage: await q(`SELECT COALESCE(SUM(file_size),0) n FROM content`),
      });
    }
    if (sub === "content" && m === "GET") {
      const kind = url.searchParams.get("kind");
      const r = await env.DB.prepare(`SELECT ${publicCols},status FROM content ${kind ? "WHERE kind=?" : ""} ORDER BY created_at DESC LIMIT 200`).bind(...(kind ? [kind] : [])).all();
      return json({ items: r.results });
    }
    if (sub === "content" && m === "POST" && !parts[2]) return saveContent(env, req, null);
    if (sub === "content" && parts[2]) {
      const id = Number(parts[2]);
      if (!Number.isInteger(id)) throw new HttpError(400, "Bad id.");
      if (m === "PUT") return saveContent(env, req, id);
      if (m === "POST" && parts[3] === "status") {
        const b = await body<{ status: string }>(req);
        if (b.status !== "draft" && b.status !== "published") throw new HttpError(400, "Status must be draft or published.");
        const row = await env.DB.prepare(`SELECT file_key FROM content WHERE id=?`).bind(id).first<any>();
        if (!row) throw new HttpError(404, "Item not found.");
        if (b.status === "published" && !row.file_key) throw new HttpError(400, "Upload a file before publishing.");
        await env.DB.prepare(`UPDATE content SET status=?,updated_at=datetime('now') WHERE id=?`).bind(b.status, id).run();
        return json({ ok: true });
      }
      if (m === "DELETE") {
        const row = await env.DB.prepare(`SELECT file_key,thumbnail_key FROM content WHERE id=?`).bind(id).first<any>();
        if (!row) throw new HttpError(404, "Item not found.");
        await env.DB.prepare(`DELETE FROM content WHERE id=?`).bind(id).run();
        const keys = [row.file_key, row.thumbnail_key].filter(Boolean);
        if (keys.length) await env.FILES.delete(keys);
        return json({ ok: true });
      }
    }
    if (sub === "users" && m === "GET") return json({ items: (await env.DB.prepare(`SELECT id,email,display_name,role,coins,created_at FROM users ORDER BY id DESC LIMIT 200`).all()).results });
    if (sub === "downloads" && m === "GET") {
      const r = await env.DB.prepare(`SELECT d.id,d.created_at,c.name,u.email FROM downloads d JOIN content c ON c.id=d.content_id LEFT JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 200`).all();
      return json({ items: r.results });
    }
  }
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("Unhandled error:", err);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
