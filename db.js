const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const configuredDbPath = process.env.SQLITE_PATH;
const defaultDbPath = path.join(__dirname, "data", "vicbest.db");
const dbPath = configuredDbPath ? path.resolve(configuredDbPath) : defaultDbPath;

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function columnExists(tableName, columnName) {
  const columns = await all(`PRAGMA table_info(${tableName})`);
  return columns.some((c) => c.name === columnName);
}

async function applyMigrations() {
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const migrations = [
    {
      name: "20260208_add_order_lifecycle_columns",
      up: async () => {
        if (!(await columnExists("orders", "processing_at"))) {
          await run(`ALTER TABLE orders ADD COLUMN processing_at DATETIME`);
        }
        if (!(await columnExists("orders", "delivered_at"))) {
          await run(`ALTER TABLE orders ADD COLUMN delivered_at DATETIME`);
        }
        if (!(await columnExists("orders", "cancelled_at"))) {
          await run(`ALTER TABLE orders ADD COLUMN cancelled_at DATETIME`);
        }
      },
    },
    {
      name: "20260208_normalize_order_statuses",
      up: async () => {
        await run(
          `UPDATE orders
           SET status = CASE
             WHEN status IN ('pending_payment', 'paid', 'processing', 'delivered', 'cancelled') THEN status
             WHEN status IS NULL OR TRIM(status) = '' THEN 'pending_payment'
             ELSE 'pending_payment'
           END`
        );
      },
    },
    {
      name: "20260208_add_users_and_order_owner",
      up: async () => {
        await run(`CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        if (!(await columnExists("orders", "user_id"))) {
          await run(`ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id)`);
          await run(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`);
        }
      },
    },
    {
      name: "20260210_add_product_stock_quantity",
      up: async () => {
        if (!(await columnExists("products", "stock_quantity"))) {
          await run(`ALTER TABLE products ADD COLUMN stock_quantity INTEGER NOT NULL DEFAULT 10`);
        }
      },
    },
    {
      name: "20260210_add_delivery_zone_and_order_fee_columns",
      up: async () => {
        await run(`CREATE TABLE IF NOT EXISTS delivery_zones (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          flat_fee INTEGER NOT NULL DEFAULT 0,
          is_covered INTEGER NOT NULL DEFAULT 1,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        if (!(await columnExists("orders", "delivery_zone_code"))) {
          await run(`ALTER TABLE orders ADD COLUMN delivery_zone_code TEXT`);
        }
        if (!(await columnExists("orders", "delivery_zone_name"))) {
          await run(`ALTER TABLE orders ADD COLUMN delivery_zone_name TEXT`);
        }
        if (!(await columnExists("orders", "subtotal_amount"))) {
          await run(`ALTER TABLE orders ADD COLUMN subtotal_amount INTEGER`);
        }
        if (!(await columnExists("orders", "delivery_fee"))) {
          await run(`ALTER TABLE orders ADD COLUMN delivery_fee INTEGER`);
        }
        if (!(await columnExists("orders", "grand_total"))) {
          await run(`ALTER TABLE orders ADD COLUMN grand_total INTEGER`);
        }
      },
    },
  ];

  for (const migration of migrations) {
    const applied = await get("SELECT id FROM schema_migrations WHERE name = ?", [migration.name]);
    if (applied) continue;
    await migration.up();
    await run("INSERT INTO schema_migrations (name) VALUES (?)", [migration.name]);
  }
}

async function seedProducts() {
  const row = await get("SELECT COUNT(*) AS count FROM products");
  if (row.count > 0) return;

  const products = [
    ["2018 Toyota Camry", "car", 18500000, "Premium foreign used sedan", "https://images.unsplash.com/photo-1550355291-bbee04a92027?auto=format&fit=crop&w=800&q=80", '{"mileage":"45k mi","fuel":"Petrol","transmission":"Auto"}', 1, 3],
    ["2020 Lexus RX 350", "car", 45000000, "Luxury SUV, near-new condition", "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=800&q=80", '{"mileage":"12k mi","fuel":"Petrol","transmission":"Auto"}', 1, 2],
    ["2019 Mercedes GLK", "car", 28000000, "Well maintained executive SUV", "https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=800&q=80", '{"mileage":"30k mi","fuel":"Petrol","transmission":"Auto"}', 1, 1],
    ["Long Grain Rice (50kg)", "grocery", 75000, "Stone-free premium long grain rice", "https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=400&q=80", '{"unit":"bag"}', 1, 12],
    ["Italian Pasta (20 packs)", "grocery", 12500, "Durum wheat pasta carton", "https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?auto=format&fit=crop&w=400&q=80", '{"unit":"carton"}', 1, 8],
    ["Fresh Beef (per kg)", "grocery", 4500, "Freshly cut beef", "https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?auto=format&fit=crop&w=400&q=80", '{"unit":"kg"}', 1, 18],
    ["Vegetable Oil (5L)", "grocery", 10500, "Refined vegetable cooking oil", "https://images.unsplash.com/photo-1601039641847-7857b994d704?auto=format&fit=crop&w=400&q=80", '{"unit":"bottle"}', 1, 9],
    ["Beverage Pack", "grocery", 15000, "Assorted non-alcoholic drinks", "https://images.unsplash.com/photo-1598511726623-d2199042b5a8?auto=format&fit=crop&w=400&q=80", '{"unit":"case"}', 1, 5],
  ];

  for (const p of products) {
    await run(
      `INSERT INTO products (name, category, price, description, image_url, metadata, in_stock, stock_quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      p
    );
  }
}

async function seedDeliveryZones() {
  const zones = [
    ["lagos_mainland", "Lagos Mainland", 3000, 1, 1],
    ["lagos_island", "Lagos Island", 5000, 1, 1],
    ["abuja", "Abuja", 7000, 1, 1],
    ["outside_coverage", "Outside Coverage", 0, 0, 1],
  ];

  for (const zone of zones) {
    await run(
      `INSERT INTO delivery_zones (code, name, flat_fee, is_covered, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name,
         flat_fee = excluded.flat_fee,
         is_covered = excluded.is_covered,
         is_active = excluded.is_active,
         updated_at = CURRENT_TIMESTAMP`,
      zone
    );
  }
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL,
    description TEXT,
    image_url TEXT,
    metadata TEXT,
    in_stock INTEGER DEFAULT 1,
    stock_quantity INTEGER NOT NULL DEFAULT 10,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT,
    shipping_address TEXT,
    notes TEXT,
    amount INTEGER NOT NULL,
    currency TEXT DEFAULT 'NGN',
    status TEXT NOT NULL DEFAULT 'pending_payment',
    payment_reference TEXT UNIQUE,
    paystack_access_code TEXT,
    paid_at DATETIME,
    processing_at DATETIME,
    delivered_at DATETIME,
    cancelled_at DATETIME,
    delivery_zone_code TEXT,
    delivery_zone_name TEXT,
    subtotal_amount INTEGER,
    delivery_fee INTEGER,
    grand_total INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    line_total INTEGER NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS cart_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS delivery_zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    flat_fee INTEGER NOT NULL DEFAULT 0,
    is_covered INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await applyMigrations();
  if (await columnExists("orders", "user_id")) {
    await run(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`);
  }
  await seedProducts();
  await seedDeliveryZones();
}

module.exports = { db, run, get, all, initDb };