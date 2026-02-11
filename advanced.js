const crypto = require("crypto");

async function columnExists(all, tableName, columnName) {
  const cols = await all(`PRAGMA table_info(${tableName})`);
  return cols.some((c) => c.name === columnName);
}

async function ensureAdvancedSchema({ run, all }) {
  await run(`CREATE TABLE IF NOT EXISTS promo_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    category TEXT,
    min_cart_amount INTEGER,
    discount_type TEXT,
    discount_value INTEGER,
    bogo_product_id INTEGER,
    bogo_buy_qty INTEGER DEFAULT 1,
    bogo_get_qty INTEGER DEFAULT 1,
    starts_at DATETIME,
    ends_at DATETIME,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS cart_recovery_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_snapshot_id INTEGER,
    channel TEXT,
    recipient TEXT,
    status TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'manager',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    product_id INTEGER,
    user_id INTEGER,
    session_id TEXT,
    location TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS user_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    label TEXT,
    recipient_name TEXT,
    phone TEXT,
    address_line TEXT NOT NULL,
    city TEXT,
    state TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS loyalty_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    points INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    reference TEXT,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS return_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    user_id INTEGER,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'requested',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS return_request_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_request_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(return_request_id) REFERENCES return_requests(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS inventory_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    eta_days INTEGER DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS product_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    location_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_id, location_id),
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(location_id) REFERENCES inventory_locations(id)
  )`);

  if (!(await columnExists(all, "cart_snapshots", "customer_email"))) {
    await run(`ALTER TABLE cart_snapshots ADD COLUMN customer_email TEXT`);
  }
  if (!(await columnExists(all, "cart_snapshots", "customer_phone"))) {
    await run(`ALTER TABLE cart_snapshots ADD COLUMN customer_phone TEXT`);
  }
  if (!(await columnExists(all, "cart_snapshots", "restore_token"))) {
    await run(`ALTER TABLE cart_snapshots ADD COLUMN restore_token TEXT`);
  }
  if (!(await columnExists(all, "cart_snapshots", "abandoned_notified_at"))) {
    await run(`ALTER TABLE cart_snapshots ADD COLUMN abandoned_notified_at DATETIME`);
  }

  if (!(await columnExists(all, "users", "referral_code"))) {
    await run(`ALTER TABLE users ADD COLUMN referral_code TEXT`);
  }
  if (!(await columnExists(all, "users", "referred_by"))) {
    await run(`ALTER TABLE users ADD COLUMN referred_by TEXT`);
  }
  if (!(await columnExists(all, "users", "total_loyalty_points"))) {
    await run(`ALTER TABLE users ADD COLUMN total_loyalty_points INTEGER NOT NULL DEFAULT 0`);
  }

  if (!(await columnExists(all, "orders", "promo_discount_amount"))) {
    await run(`ALTER TABLE orders ADD COLUMN promo_discount_amount INTEGER`);
  }
  if (!(await columnExists(all, "orders", "promo_rule_ids"))) {
    await run(`ALTER TABLE orders ADD COLUMN promo_rule_ids TEXT`);
  }
  if (!(await columnExists(all, "orders", "risk_score"))) {
    await run(`ALTER TABLE orders ADD COLUMN risk_score INTEGER`);
  }
  if (!(await columnExists(all, "orders", "risk_level"))) {
    await run(`ALTER TABLE orders ADD COLUMN risk_level TEXT`);
  }
  if (!(await columnExists(all, "orders", "risk_flags"))) {
    await run(`ALTER TABLE orders ADD COLUMN risk_flags TEXT`);
  }
  if (!(await columnExists(all, "orders", "manual_review_status"))) {
    await run(`ALTER TABLE orders ADD COLUMN manual_review_status TEXT`);
  }

  await run(`INSERT INTO inventory_locations (code, name, eta_days, is_active, updated_at)
    VALUES ('default', 'Main Warehouse', 1, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, is_active=1, updated_at=CURRENT_TIMESTAMP`);
}

function buildDeterministicAssistantReply(query, products) {
  const q = String(query || "").toLowerCase();
  const budgetMatch = q.match(/(\d[\d,]*)/);
  const budget = budgetMatch ? Number(budgetMatch[1].replace(/,/g, "")) : null;
  const category = q.includes("car") ? "car" : (q.includes("grocery") || q.includes("food")) ? "grocery" : null;

  let picks = products.filter((p) => Number(p.in_stock) === 1);
  if (category) picks = picks.filter((p) => p.category === category);
  if (budget && Number.isFinite(budget)) picks = picks.filter((p) => Number(p.price) <= budget);

  const useCaseBoost = ["family", "luxury", "cheap", "budget", "bulk", "daily"];
  picks = picks
    .map((p) => {
      let score = 0;
      for (const k of useCaseBoost) {
        if (q.includes(k) && String(p.name || "").toLowerCase().includes(k)) score += 3;
      }
      score += Math.max(0, 5 - Math.floor(Number(p.price || 0) / 10000000));
      return { ...p, _score: score };
    })
    .sort((a, b) => b._score - a._score || a.price - b.price)
    .slice(0, 5)
    .map(({ _score, ...rest }) => rest);

  const responseText = picks.length
    ? `Here are ${picks.length} suggestions${budget ? ` within ₦${budget.toLocaleString("en-NG")}` : ""}.`
    : "I could not find an exact match. Try broader budget/category keywords.";

  return { responseText, intent: { budget, category }, products: picks };
}

function makeRestoreToken() {
  return crypto.randomBytes(16).toString("hex");
}

module.exports = { ensureAdvancedSchema, buildDeterministicAssistantReply, makeRestoreToken };
