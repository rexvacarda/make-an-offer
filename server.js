// server.js
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

// --- CORS allowlist ---
const allow = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allow.includes(origin)),
}));

// --- SQLite (persistent disk) ---
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
    discount_code TEXT,
    price_rule_id TEXT,
    discount_expires_at DATETIME,
    draft_order_id TEXT,
    drafted_at DATETIME,
    ip TEXT, ua TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offers_created ON offers(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_offers_email_variant ON offers(email_norm,variant_id)`);
  // idempotent columns
  db.run(`ALTER TABLE offers ADD COLUMN discount_code TEXT`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN price_rule_id TEXT`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN discount_expires_at DATETIME`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN draft_order_id TEXT`, () => {});
  db.run(`ALTER TABLE offers ADD COLUMN drafted_at DATETIME`, () => {});
});

// --- Mailer (optional) ---
let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } : undefined
  });
}

// ---- Shopify helpers ----
const SHOP = process.env.SHOPIFY_SHOP; // yourstore.myshopify.com
const API_V = process.env.SHOPIFY_API_VERSION || "2025-07";
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// REST
async function shopifyFetch(pathname, method = "GET", body = null) {
  if (!SHOP || !ADMIN_TOKEN) throw new Error("Shopify admin not configured");
  const url = `https://${SHOP}/admin/api/${API_V}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Shopify REST ${method} ${pathname} ${res.status}: ${text}`);
    throw new Error(`Shopify REST ${res.status}`);
  }
  return res.json();
}

// GraphQL
async function shopifyGraphQL(query, variables) {
  if (!SHOP || !ADMIN_TOKEN) throw new Error("Shopify admin not configured");
  const url = `https://${SHOP}/admin/api/${API_V}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error("Shopify GQL error:", JSON.stringify(json, null, 2));
    throw new Error("Shopify GraphQL error");
  }
  return json.data;
}

// --- Market mapping (domain -> currency & country) ---
const MARKET_MAP = (() => {
  try { return JSON.parse(process.env.MARKET_MAP_JSON || "[]"); } catch { return []; }
})();
function resolveMarketForHost(host) {
  const h = String(host || "").toLowerCase();
  const found = MARKET_MAP.find(m => m.host.toLowerCase() === h);
  if (found) return { currency: found.currency, country: found.country };
  // naive fallback by TLD
  if (h.endsWith(".jp")) return { currency: "JPY", country: "JP" };
  if (h.endsWith(".co.uk") || h.endsWith(".uk") || h.endsWith(".com")) return { currency: "GBP", country: "GB" };
  return { currency: "GBP", country: "GB" };
}

function getNumericId(maybeId) {
  const m = String(maybeId || "").match(/\d+$/);
  return m ? Number(m[0]) : NaN;
}
const toGID = (type, id) => `gid://shopify/${type}/${id}`;

/** Create code (global, shop currency) for single accepted item */
async function createDiscountForOffer(row) {
  if (!row.price_cents || !row.offer_cents) throw new Error("Missing price/offer");
  const diffCents = Math.max(0, row.price_cents - row.offer_cents);
  if (diffCents <= 0) throw new Error("Offer >= price; no discount needed");

  const variantNumericId = getNumericId(row.variant_id);
  if (!variantNumericId) throw new Error(`Bad variant_id: ${row.variant_id}`);

  const valueFixed = `-${(diffCents / 100).toFixed(2)}`;
  const code = `OFFER-${row.id}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const startsAt = new Date().toISOString();
  const ttlDays = Number(process.env.DISCOUNT_TTL_DAYS || 7);
  const endsAt = new Date(Date.now() + ttlDays * 864e5).toISOString();

  const prBody = {
    price_rule: {
      title: `Offer ${row.id} – ${row.product_title}`,
      target_type: "line_item",
      target_selection: "entitled",
      allocation_method: "each",
      value_type: "fixed_amount",
      value: valueFixed,
      customer_selection: "all",
      starts_at: startsAt,
      ends_at: endsAt,
      usage_limit: 1,
      once_per_customer: true,
      entitled_variant_ids: [ variantNumericId ]
    }
  };

  const pr = await shopifyFetch(`/price_rules.json`, "POST", prBody);
  const priceRuleId = pr?.price_rule?.id;
  if (!priceRuleId) throw new Error("No price_rule.id returned");

  const dc = await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`, "POST", {
    discount_code: { code }
  });
  const createdCode = dc?.discount_code?.code || code;

  await new Promise((resolve, reject) => {
    db.run(
      "UPDATE offers SET discount_code=?, price_rule_id=?, discount_expires_at=? WHERE id=?",
      [createdCode, String(priceRuleId), endsAt, row.id],
      (err) => err ? reject(err) : resolve()
    );
  });

  return { code: createdCode, priceRuleId, endsAt };
}

/** NEW: Create a draft order priced in the customer's market currency */
async function createDraftForEmailAndShop(emailNorm, shopDomain) {
  // Collect accepted offers for this email+domain that aren't drafted yet
  const rows = await new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM offers
       WHERE email_norm=? AND shop_domain=? AND status='accepted'
         AND (draft_order_id IS NULL OR draft_order_id='')
       ORDER BY created_at ASC`,
      [emailNorm, shopDomain],
      (err, rs) => err ? reject(err) : resolve(rs || [])
    );
  });
  if (!rows.length) throw new Error("No accepted offers to draft");

  const { currency: presentmentCurrency, country } = resolveMarketForHost(shopDomain);
  const email = rows[0].email;

  // Build GIDs + price overrides in presentment currency
  const line_items = [];
  const ids = [];
  for (const r of rows) {
    const numeric = getNumericId(r.variant_id);
    if (!numeric) { console.error("Skip bad variant_id:", r.variant_id); continue; }
    line_items.push({
      variantId: toGID("ProductVariant", numeric),
      quantity: 1,
      // IMPORTANT: priceOverride expects presentment currency
      priceOverride: {
        amount: (r.offer_cents / 100).toFixed(2),
        currencyCode: presentmentCurrency
      },
      customAttributes: [{ key: "OfferID", value: String(r.id) }]
    });
    ids.push(r.id);
  }
  if (!line_items.length) throw new Error("No valid line items from offers");

  // GraphQL draftOrderCreate with presentmentCurrencyCode
  const mutation = `
    mutation CreateDraft($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl presentmentCurrencyCode }
        userErrors { field message }
      }
    }
  `;
  const input = {
    email,
    lineItems: line_items,
    presentmentCurrencyCode: presentmentCurrency, // key bit for Markets
    note: `Offers: ${ids.join(", ")} (market ${country}/${presentmentCurrency})`,
    tags: ["make-offer"]
  };

  const data = await shopifyGraphQL(mutation, { input });
  const payload = data?.draftOrderCreate;
  const gqlId = payload?.draftOrder?.id;
  if (!gqlId) {
    const errs = (payload?.userErrors || []).map(e => e.message).join("; ");
    throw new Error(`Draft create failed: ${errs || "no id"}`);
  }

  // store marker
  await new Promise((resolve, reject) => {
    const placeholders = ids.map(() => "?").join(",");
    db.run(
      `UPDATE offers SET draft_order_id=?, drafted_at=CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      [String(gqlId), ...ids],
      (err) => err ? reject(err) : resolve()
    );
  });

  // Send invoice via GraphQL (Shopify emails the customer)
  try {
    const send = `
      mutation SendInvoice($id: ID!, $to: String!, $subject: String, $msg: String) {
        draftOrderInvoiceSend(id: $id, to: $to, subject: $subject, customMessage: $msg) {
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }
    `;
    await shopifyGraphQL(send, {
      id: gqlId,
      to: email,
      subject: "Your offer checkout",
      msg: "We’ve bundled the items you offered on. Complete checkout when ready."
    });
  } catch (e) {
    console.error("send_invoice failed:", e.message);
  }

  return { draftId: gqlId, count: ids.length, email, presentmentCurrency };
}

// --- Health + root page ---
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/", (req, res) => {
  res.send(`<!doctype html><meta charset="utf-8">
  <title>Offer Service</title>
  <style>body{font:14px system-ui;margin:40px;line-height:1.5}</style>
  <h2>Offer service is running ✅</h2>
  <p>Health: <a href="/health">/health</a></p>
  <p>Admin: <a href="/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">/admin/offers</a></p>`);
});

// --- Rate limit ---
const postLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

// --- Create offer ---
app.post("/api/offer", postLimiter, (req, res) => {
  const o = req.body || {};
  const origin = req.headers.origin || "";
  if (allow.length && !allow.includes(origin)) return res.status(403).json({ ok: false, error: "Forbidden origin" });

  const email = String(o.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ ok: false, error: "Invalid email" });

  const product_id = String(o.product_id || "");
  const variant_id = String(o.variant_id || "");
  if (!product_id || !variant_id) return res.status(400).json({ ok: false, error: "Missing product/variant" });

  const offer_cents = Math.max(0, Math.round(parseFloat(o.offer || 0) * 100));
  if (!offer_cents) return res.status(400).json({ ok: false, error: "Offer required" });

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

  // Allow multiple products; only block same variant in last 24h:
  db.get(
    `SELECT id FROM offers
     WHERE email_norm=? AND variant_id=? AND status='open'
       AND datetime(created_at) >= datetime('now','-1 day')`,
    [row.email_norm, row.variant_id],
    (err, exists) => {
      if (err) return res.status(500).json({ ok: false, error: "DB error" });
      if (exists) return res.status(429).json({ ok: false, error: "You already made an offer for this variant in the last 24 hours." });

      db.run(
        `INSERT INTO offers
         (shop_domain,product_id,product_handle,product_title,variant_id,variant_title,currency,price_cents,offer_cents,email,email_norm,note,ip,ua)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.shop_domain,row.product_id,row.product_handle,row.product_title,row.variant_id,row.variant_title,row.currency,row.price_cents,row.offer_cents,row.email,row.email_norm,row.note,row.ip,row.ua],
        function(insertErr){
          if (insertErr) return res.status(500).json({ ok: false, error: "Insert failed" });

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

          res.json({ ok: true, id: this.lastID });
        }
      );
    }
  );
});

// --- Admin table ---
app.get("/admin/offers", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  db.all("SELECT * FROM offers ORDER BY created_at DESC LIMIT 500", [], (err, rows) => {
    if (err) return res.status(500).send("DB error");
    const esc = s => String(s||"").replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
    const tr = r => {
      const vid = getNumericId(r.variant_id);
      const codeLink = r.discount_code
        ? `<br><a href="https://${esc(r.shop_domain)}/discount/${encodeURIComponent(r.discount_code)}?redirect=%2Fcart%2Fadd%3Fid%3D${encodeURIComponent(vid)}%26quantity%3D1%26return_to%3D%252Fcart" target="_blank">Open with item</a>`
        : `<br><a href="/admin/offers/${r.id}/create-code?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Create code</a>`;
      const draftLink = (r.status === 'accepted')
        ? `<br><a href="/admin/offers/${r.id}/draft?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Draft for this email</a>`
        : "";
      return `<tr>
        <td>${r.id}</td><td>${r.created_at}</td>
        <td>${esc(r.product_title)}<br><small>${esc(r.variant_title)}</small></td>
        <td>${r.currency} ${(r.price_cents/100).toFixed(2)}</td>
        <td><b>${r.currency} ${(r.offer_cents/100).toFixed(2)}</b></td>
        <td>${esc(r.email)}</td>
        <td>${r.status}${r.discount_code ? `<br><small>Code: ${esc(r.discount_code)}</small>` : ""}${r.draft_order_id ? `<br><small>Draft: ${esc(r.draft_order_id)}</small>` : ""}</td>
        <td>
          <a href="/admin/offers/${r.id}/status?value=accepted&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Accept</a> ·
          <a href="/admin/offers/${r.id}/status?value=declined&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Decline</a> ·
          <a href="/admin/offers/${r.id}/status?value=open&key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}">Reopen</a>
          ${codeLink}
          ${draftLink}
        </td></tr>`;
    };
    res.send(`<!doctype html><meta charset="utf-8"><title>Offers</title>
      <style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px}th{background:#f6f6f6}</style>
      <h2>Offers</h2>
      <table><tr><th>ID</th><th>Time</th><th>Product</th><th>Price</th><th>Offer</th><th>Email</th><th>Status</th><th>Action</th></tr>
      ${rows.map(tr).join("")}</table>`);
  });
});

// --- Manual retry: create code ---
app.get("/admin/offers/:id/create-code", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  const id = Number(req.params.id || 0);
  db.get("SELECT * FROM offers WHERE id=?", [id], async (err, row) => {
    if (err || !row) return res.status(404).send("Offer not found");
    try {
      if (!row.discount_code) await createDiscountForOffer(row);
    } catch (e) {
      console.error("Manual discount creation failed:", e.message);
    } finally {
      res.redirect(`/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}`);
    }
  });
});

// --- NEW: Create draft for this email (bundles multiple accepted offers) ---
app.get("/admin/offers/:id/draft", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  const id = Number(req.params.id || 0);
  db.get("SELECT * FROM offers WHERE id=?", [id], async (err, row) => {
    if (err || !row) return res.status(404).send("Offer not found");
    try {
      await createDraftForEmailAndShop(row.email_norm, row.shop_domain);
      if (mailer && row.email) {
        await mailer.sendMail({
          to: row.email,
          from: process.env.EMAIL_USER,
          subject: "Your offers are ready to checkout",
          html: `<p>We’ve created a checkout for your accepted items in your local currency. A Shopify invoice has been emailed to you.</p>`
        }).catch(()=>{});
      }
    } catch (e) {
      console.error("Draft order creation failed:", e.message);
    } finally {
      res.redirect(`/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}`);
    }
  });
});

// --- Accept/Decline (creates code on Accept + emails customer) ---
app.get("/admin/offers/:id/status", (req, res) => {
  if (req.query.key !== process.env.OFFER_ADMIN_KEY) return res.status(403).send("Forbidden");
  const id = Number(req.params.id || 0);
  const val = String(req.query.value || "open");
  if (!["open","accepted","declined","expired"].includes(val)) return res.status(400).send("Bad status");

  db.get("SELECT * FROM offers WHERE id=?", [id], async (err, row) => {
    if (err || !row) return res.status(404).send("Offer not found");

    db.run("UPDATE offers SET status=? WHERE id=?", [val, id], async (uerr) => {
      if (uerr) return res.status(500).send("DB error");

      if (val === "accepted") {
        let codeInfo = null;
        try {
          if (!row.discount_code) {
            codeInfo = await createDiscountForOffer(row);
          } else {
            codeInfo = { code: row.discount_code, priceRuleId: row.price_rule_id, endsAt: row.discount_expires_at };
          }
        } catch (e) {
          console.error("Discount creation failed:", e.message);
        }

        if (mailer && row.email) {
          try {
            const fmt = n => (n/100).toFixed(2);
            const code = codeInfo?.code || "(contact us)";
            const host = row.shop_domain || "smelltoimpress.com";
            const variantId = getNumericId(row.variant_id);

            const addPath   = `/cart/add?id=${encodeURIComponent(variantId)}&quantity=1&return_to=%2Fcart`;
            const withItem  = `https://${host}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(addPath)}`;
            const applyOnly = `https://${host}/discount/${encodeURIComponent(code)}?redirect=%2Fcart`;

            const subject = `Offer accepted – ${row.product_title}`;
            const html = `
              <p>Great news — we’ve accepted your offer of <b>${row.currency} ${fmt(row.offer_cents)}</b> for <b>${row.product_title}</b> (${row.variant_title}).</p>
              <p>Your single-use discount code${codeInfo?.endsAt ? ` (valid until <b>${new Date(codeInfo.endsAt).toLocaleDateString()}</b>)` : ""}:</p>
              <p style="font-size:18px"><b>${code}</b></p>
              <ul>
                <li><a href="${withItem}">Add the item and apply the code</a></li>
                <li><a href="${applyOnly}">Apply the code and go to your cart</a> (you can add other items)</li>
              </ul>
              <p>Tip: if you have multiple accepted offers, reply to this email and we’ll send a combined checkout.</p>
            `;
            await mailer.sendMail({ to: row.email, from: process.env.EMAIL_USER, subject, html });
          } catch (e) {
            console.error("Email on accept failed:", e.message);
          }
        }
      }

      if (val === "declined" && mailer && row.email) {
        try {
          await mailer.sendMail({
            to: row.email,
            from: process.env.EMAIL_USER,
            subject: `Offer update – ${row.product_title}`,
            html: `<p>Thanks for your offer on <b>${row.product_title}</b>. We can’t accept that amount right now, but feel free to reply with a revised offer.</p>`
          });
        } catch(e){ console.error("Decline email failed:", e.message); }
      }

      res.redirect(`/admin/offers?key=${encodeURIComponent(process.env.OFFER_ADMIN_KEY)}`);
    });
  });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log("offer-service up on", port));