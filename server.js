const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const sqlite3 = require("sqlite3").verbose();
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(helmet({ crossOriginResourcePolicy: false }));

// --- CORS allowlist
const allow = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allow.includes(origin)),
}));

// --- SQLite (persistent disk)
const dbFile = process.env.DATABASE_FILE || path.join(__dirname, "..", "data", "offers.sqlite");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS offers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    shop_domain TEXT,
    product_id TEXT, product_handle TEXT, product_title TEXT,
    variant_id TEXT, variant_title TEXT,
    currency TEXT, price_cents INTEGER, offer_cents INTEGER,
    email TEXT, email_norm TEXT, note TEXT,
    status TEXT DEFAULT 'open',     -- open|accepted|declined|expired
    ip TEXT, ua TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offers_created ON offers(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offers_email_variant ON offers(email_norm,variant_id)`);
});

// --- Mailer (optional)
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } : undefined
  });
}

// --- Health
app.get("/health", (_, res) => res.json({ ok: true }));

// --- Rate limit: allow many products, just block bursts per IP
const postLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

// --- Create offer (user can submit for multiple products)
// Only dedupe same email+variant within 24h (so different products are allowed).
app.post("/api/offer", postLimiter, (req, res) => {
  const o = req.body || {};
  const origin = req.headers.origin || "";
  if (allow.length && !allow.includes(origin)) return res.status(403).json({ ok:false, error:"Forbidden origin" });

  const email = String(o.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ ok:false, error:"Invalid email" });

  const product_id = String(o.product_id || "");
  const variant_id = String(o.variant_id || "");
  if (!product_id || !variant_id) return res.status(400).json({ ok:false, error:"Missing product/variant" });

  const offer_cents = Math.max(0, Math.round(parseFloat(o.offer || 0) * 100));
  if (!offer_cents) return res.status(400).json({ ok:false, error:"Offer required" });

  const row = {
    shop_domain: String(o.shop_domain || ""),
    product_id,
    product_handle: String(o.product_handle || ""),
    product_title: String(o.product_title || ""),
    variant_id,
    variant_title: String(o.variant_title || ""),
    currency: String(o.currency || "GBP"),
    price_cents: Math.max(0, parseInt(o.price_cents || 0, 10)),
    offer_cents,
    email,
    email_norm: email.toLowerCase(),
    note: String(o.note || "").slice(0, 2000),
    ip: String(req.headers["cf-connecting-ip"] || req.ip || ""),
    ua: String(req.headers["user-agent"] || "")
  };

  // Allow multiple products; only block duplicate for the SAME variant within 24h:
  db.get(
    `SELECT id FROM offers
     WHERE email_norm=? AND variant_id=? AND status='open'
       AND datetime(created_at) >= datetime('now','-1 day')`,
    [row.email_norm, row.variant_id],
    (err, exists) => {
      if (err) return res.status(500).json({ ok:false, error:"DB error" });
      if (exists) return res.status(429).json({ ok:false, error:"You already made an offer for this variant in the last 24 hours." });

      db.run(
        `INSERT INTO offers
         (shop_domain,product_id,product_handle,product_title,variant_id,variant_title,currency,price_cents,offer_cents,email,email_norm,note,ip,ua)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.shop_domain,row.product_id,row.product_handle,row.product_title,row.variant_id,row.variant_title,row.currency,row.price_cents,row.offer_cents,row.email,row.email_norm,row.note,row.ip,row.ua],
        function(insertErr){
          if (insertErr) return res.status(500).json({ ok:false, error:"Insert failed" });

          if (mailer && process.env.OFFER_TO_EMAIL) {
            const fmt = n => (n/100).toFixed(2);
            const subject = `New offer: ${row.currency} ${fmt(row.offer_cents)} – ${row.product_title} (${row.variant_title})`;
            const html = `
              <p><b>New offer received</b></p>
              <ul>
                <li>Product: ${row.product_title} (${row.product_handle})</li>
                <li>Variant: ${row.variant_title} (#${row.variant_id})</li>
                <li>Price: ${row.currency} ${(row.price_cents/100).toFixed(2)}</li>
                <li>Offer: <b>${row.currency} ${(row.offer_cents/100).toFixed(2)}</b></li>
                <li>Email: ${row.email}</li>
                <li>Note: ${row.note || "-"}</li>
                <li>Shop: ${row.shop_domain}</li>
              </ul>
              <p><a href="/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Open admin</a></p>`;
            mailer.sendMail({ to: process.env.OFFER_TO_EMAIL, from: process.env.EMAIL_USER, subject, html }).catch(()=>{});
            mailer.sendMail({
              to: row.email, from: process.env.EMAIL_USER,
              subject: `We received your offer – ${row.product_title}`,
              text: `Thanks! Your offer of ${row.currency} ${(row.offer_cents/100).toFixed(2)} was received. We’ll get back to you soon.`
            }).catch(()=>{});
          }

          res.json({ ok:true, id: this.lastID });
        }
      );
    }
  );
});

// --- Minimal admin
app.get("/admin/offers", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  db.all("SELECT * FROM offers ORDER BY created_at DESC LIMIT 500", [], (err, rows) => {
    if (err) return res.status(500).send("DB error");
    const esc = s => String(s||"").replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    const tr = r => `<tr>
      <td>${r.id}</td><td>${r.created_at}</td>
      <td>${esc(r.product_title)}<br><small>${esc(r.variant_title)}</small></td>
      <td>${r.currency} ${(r.price_cents/100).toFixed(2)}</td>
      <td><b>${r.currency} ${(r.offer_cents/100).toFixed(2)}</b></td>
      <td>${esc(r.email)}</td><td>${r.status}</td>
      <td>
        <a href="/admin/offers/${r.id}/status?value=accepted&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Accept</a> ·
        <a href="/admin/offers/${r.id}/status?value=declined&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Decline</a> ·
        <a href="/admin/offers/${r.id}/status?value=open&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Reopen</a>
      </td></tr>`;
    res.send(`<!doctype html><meta charset="utf-8"><title>Offers</title>
      <style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px}th{background:#f6f6f6}</style>
      <h2>Offers</h2>
      <table><tr><th>ID</th><th>Time</th><th>Product</th><th>Price</th><th>Offer</th><th>Email</th><th>Status</th><th>Action</th></tr>
      ${rows.map(tr).join("")}</table>`);
  });
});

app.get("/admin/offers/:id/status", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  const id = Number(req.params.id || 0);
  const val = String(req.query.value || "open");
  if (!["open","accepted","declined","expired"].includes(val)) return res.status(400).send("Bad status");
  db.run("UPDATE offers SET status=? WHERE id=?", [val, id], err =>
    err ? res.status(500).send("DB error")
        : res.redirect(`/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}`)
  );
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log("offer-service up on", port));