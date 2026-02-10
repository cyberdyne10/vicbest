require("dotenv").config();
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const express = require("express");
const path = require("path");
const { initDb, all, get, run } = require("./db");
const { notifyNewOrder, notifyOrderStatusChanged, notifyAdminLowStockSummary } = require("./notifications");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const VALID_CATEGORIES = new Set(["car", "grocery"]);
const ORDER_STATUSES = new Set(["pending_payment", "paid", "processing", "delivered", "cancelled"]);
const MAX_INPUT_LENGTH = {
  deliveryZoneCode: 80,
  deliveryZoneName: 120,
  name: 120,
  email: 160,
  password: 200,
  phone: 30,
  address: 500,
  notes: 1200,
  productName: 160,
  productDescription: 2000,
  imageUrl: 1000,
};
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

const rateStore = new Map();

app.use("/api/paystack/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return cookieHeader.split(";").reduce((acc, pair) => {
    const [rawKey, ...rest] = pair.trim().split("=");
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function formatProducts(rows) {
  return rows.map((p) => ({
    ...p,
    metadata: p.metadata ? JSON.parse(p.metadata) : {},
  }));
}

function genRef() {
  return `VICBEST-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function safeText(value, max = 255) {
  return String(value || "").trim().slice(0, max);
}

function parseCartItems(items, productMap) {
  let subtotalAmount = 0;
  const normalizedItems = [];

  for (const item of items) {
    const product = productMap.get(Number(item.productId));
    const quantity = Number(item.quantity) || 1;
    if (!product || quantity <= 0) continue;
    const lineTotal = product.price * quantity;
    subtotalAmount += lineTotal;
    normalizedItems.push({
      productId: product.id,
      productName: product.name,
      quantity,
      unitPrice: product.price,
      lineTotal,
    });
  }

  return { subtotalAmount, normalizedItems };
}

async function calculateDelivery({ deliveryZoneCode, cartSubtotal }) {
  const code = safeText(deliveryZoneCode, MAX_INPUT_LENGTH.deliveryZoneCode).toLowerCase();
  const subtotal = Number(cartSubtotal);

  if (!code) return { error: "deliveryZoneCode is required", status: 400 };
  if (!Number.isInteger(subtotal) || subtotal < 0) {
    return { error: "cartSubtotal must be a non-negative integer", status: 400 };
  }

  const zone = await get(
    "SELECT code, name, flat_fee, is_covered, is_active FROM delivery_zones WHERE code = ?",
    [code]
  );

  if (!zone || Number(zone.is_active) !== 1) {
    return { error: "Invalid delivery location", status: 400 };
  }

  if (Number(zone.is_covered) !== 1) {
    return {
      error: "Selected delivery location is currently outside coverage",
      status: 400,
      zone,
      deliveryFee: 0,
      grandTotal: subtotal,
      subtotal,
    };
  }

  const deliveryFee = Number(zone.flat_fee) || 0;
  return {
    status: 200,
    zone,
    deliveryFee,
    subtotal,
    grandTotal: subtotal + deliveryFee,
  };
}

function getOrderFinancials(order = {}) {
  const hasSubtotal = order.subtotal_amount !== null && order.subtotal_amount !== undefined && order.subtotal_amount !== "";
  const hasDeliveryFee = order.delivery_fee !== null && order.delivery_fee !== undefined && order.delivery_fee !== "";
  const hasGrandTotal = order.grand_total !== null && order.grand_total !== undefined && order.grand_total !== "";

  const subtotal = hasSubtotal ? Number(order.subtotal_amount) : Number(order.amount || 0);
  const deliveryFee = hasDeliveryFee ? Number(order.delivery_fee) : 0;
  const grandTotal = hasGrandTotal ? Number(order.grand_total) : Number(order.amount || subtotal + deliveryFee);
  return { subtotal, deliveryFee, grandTotal };
}

async function fetchOrderWithItems(orderId) {
  const order = await get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order) return null;
  const items = await all("SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC", [orderId]);
  return { order, items };
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function rateLimit({ windowMs, maxRequests }) {
  return (req, res, next) => {
    const key = `${req.path}:${getClientIp(req)}`;
    const now = Date.now();
    const hit = rateStore.get(key);
    if (!hit || now > hit.resetAt) {
      rateStore.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (hit.count >= maxRequests) {
      return res.status(429).json({ error: "Too many requests. Please try again shortly." });
    }
    hit.count += 1;
    next();
  };
}

function adminSecret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || "vicbest-admin-secret";
}

function userSecret() {
  return process.env.USER_TOKEN_SECRET || process.env.JWT_SECRET || "vicbest-user-secret";
}

function signToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [encoded, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function signAdminToken(payload) {
  return signToken(payload, adminSecret());
}

function verifyAdminToken(token) {
  return verifyToken(token, adminSecret());
}

function signUserToken(payload) {
  return signToken(payload, userSecret());
}

function verifyUserToken(token) {
  return verifyToken(token, userSecret());
}

function setUserAuthCookie(res, token) {
  res.cookie("vicbest_user_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearUserAuthCookie(res) {
  res.clearCookie("vicbest_user_token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

function userTokenFromRequest(req) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const cookies = parseCookies(req);
  return bearer || cookies.vicbest_user_token || "";
}

async function attachUser(req, _, next) {
  const payload = verifyUserToken(userTokenFromRequest(req));
  if (!payload?.sub) {
    req.user = null;
    return next();
  }

  try {
    const user = await get("SELECT id, name, email, created_at FROM users WHERE id = ?", [payload.sub]);
    req.user = user || null;
  } catch {
    req.user = null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = bearer || safeText(req.query?.token, 600);
  const payload = verifyAdminToken(token);
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  req.admin = payload;
  next();
}

function toProductPayload(body = {}) {
  const name = safeText(body.name, MAX_INPUT_LENGTH.productName);
  const category = String(body.category || "").trim();
  const price = Number(body.price);
  const description = safeText(body.description, MAX_INPUT_LENGTH.productDescription);
  const image_url = safeText(body.image_url, MAX_INPUT_LENGTH.imageUrl);
  const in_stock = body.in_stock ? 1 : 0;
  const stock_quantity = Math.max(0, Number(body.stock_quantity) || 0);
  const low_stock_threshold = body.low_stock_threshold === undefined || body.low_stock_threshold === null || body.low_stock_threshold === ""
    ? DEFAULT_LOW_STOCK_THRESHOLD
    : Number(body.low_stock_threshold);

  let metadata = body.metadata || {};
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = {};
    }
  }

  const errors = [];
  if (!name) errors.push("name is required");
  if (!VALID_CATEGORIES.has(category)) errors.push("category must be 'car' or 'grocery'");
  if (!Number.isInteger(price) || price < 0) errors.push("price must be a non-negative integer");
  if (!Number.isInteger(stock_quantity) || stock_quantity < 0) errors.push("stock_quantity must be a non-negative integer");
  if (!Number.isInteger(low_stock_threshold) || low_stock_threshold < 0) errors.push("low_stock_threshold must be a non-negative integer");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) errors.push("metadata must be an object");

  return {
    errors,
    data: {
      name,
      category,
      price,
      description,
      image_url,
      metadata: JSON.stringify(metadata),
      in_stock,
      stock_quantity,
      low_stock_threshold,
    },
  };
}

async function fetchLowStockProducts() {
  return all(
    `SELECT id, name, category, stock_quantity, low_stock_threshold, in_stock
     FROM products
     WHERE in_stock = 1 AND stock_quantity <= COALESCE(low_stock_threshold, ?)
     ORDER BY stock_quantity ASC, id ASC`,
    [DEFAULT_LOW_STOCK_THRESHOLD]
  );
}

async function getLowStockSummary() {
  const products = await fetchLowStockProducts();
  const totals = await get("SELECT COUNT(*) AS total FROM products WHERE in_stock = 1");
  return {
    generatedAt: new Date().toISOString(),
    totalInStockProducts: totals?.total || 0,
    lowStockCount: products.length,
    products: products.map((p) => ({
      ...p,
      stock_quantity: Number(p.stock_quantity || 0),
      low_stock_threshold: Number(p.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD),
      deficit: Number(p.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD) - Number(p.stock_quantity || 0),
    })),
  };
}

function hasInventoryJobAccess(req) {
  const secret = String(process.env.INVENTORY_JOB_SECRET || "").trim();
  if (!secret) return false;
  const supplied = safeText(req.headers["x-job-secret"] || req.query?.key || req.body?.key, 300);
  return supplied && supplied === secret;
}

app.use(attachUser);

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.get("/api/delivery/zones", async (_, res) => {
  try {
    const zones = await all(
      "SELECT code, name, flat_fee, is_covered FROM delivery_zones WHERE is_active = 1 ORDER BY id ASC"
    );
    res.json({ data: zones });
  } catch {
    res.status(500).json({ error: "Failed to fetch delivery zones" });
  }
});

app.post("/api/delivery/calculate", async (req, res) => {
  try {
    const result = await calculateDelivery({
      deliveryZoneCode: req.body?.deliveryZoneCode,
      cartSubtotal: req.body?.cartSubtotal,
    });

    if (result.status !== 200) {
      return res.status(result.status).json({
        error: result.error,
        data: result.zone
          ? {
              deliveryZoneCode: result.zone.code,
              deliveryZoneName: result.zone.name,
              isCovered: Number(result.zone.is_covered) === 1,
              subtotal: result.subtotal,
              deliveryFee: result.deliveryFee,
              grandTotal: result.grandTotal,
            }
          : undefined,
      });
    }

    return res.json({
      data: {
        deliveryZoneCode: result.zone.code,
        deliveryZoneName: result.zone.name,
        isCovered: Number(result.zone.is_covered) === 1,
        subtotal: result.subtotal,
        deliveryFee: result.deliveryFee,
        grandTotal: result.grandTotal,
      },
    });
  } catch {
    return res.status(500).json({ error: "Failed to calculate delivery" });
  }
});

app.post("/api/auth/register", rateLimit({ windowMs: 60_000, maxRequests: 8 }), async (req, res) => {
  try {
    const name = safeText(req.body?.name, MAX_INPUT_LENGTH.name);
    const email = normalizeEmail(safeText(req.body?.email, MAX_INPUT_LENGTH.email));
    const password = String(req.body?.password || "").slice(0, MAX_INPUT_LENGTH.password);

    if (!name) return res.status(400).json({ error: "name is required" });
    if (!email) return res.status(400).json({ error: "email is required" });
    if (password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });

    const existing = await get("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 12);
    const created = await run(
      `INSERT INTO users (name, email, password_hash, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      [name, email, hash]
    );

    const user = await get("SELECT id, name, email, created_at FROM users WHERE id = ?", [created.id]);
    const token = signUserToken({ sub: user.id, role: "user", exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    setUserAuthCookie(res, token);

    res.status(201).json({ data: user });
  } catch {
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", rateLimit({ windowMs: 60_000, maxRequests: 10 }), async (req, res) => {
  try {
    const email = normalizeEmail(safeText(req.body?.email, MAX_INPUT_LENGTH.email));
    const password = String(req.body?.password || "").slice(0, MAX_INPUT_LENGTH.password);

    if (!email || !password) return res.status(400).json({ error: "email and password are required" });

    const user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: "Invalid credentials" });

    const token = signUserToken({ sub: user.id, role: "user", exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    setUserAuthCookie(res, token);

    res.json({ data: { id: user.id, name: user.name, email: user.email, created_at: user.created_at } });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearUserAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ data: req.user || null });
});

app.get("/api/profile", requireUser, (req, res) => {
  res.json({ data: req.user });
});

app.get("/api/orders/me", requireUser, async (req, res) => {
  try {
    const orders = await all("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC", [req.user.id]);
    res.json({ data: orders });
  } catch {
    res.status(500).json({ error: "Failed to fetch your orders" });
  }
});

app.post("/api/admin/login", rateLimit({ windowMs: 60_000, maxRequests: 12 }), (req, res) => {
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword) {
    return res.status(500).json({ error: "ADMIN_PASSWORD is not configured" });
  }

  const password = String(req.body?.password || "");
  if (!password || password !== configuredPassword) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = signAdminToken({ role: "admin", exp: Date.now() + 12 * 60 * 60 * 1000 });
  res.json({ token, expiresInHours: 12 });
});

app.get("/api/products", async (req, res) => {
  try {
    const category = safeText(req.query.category, 30);
    const search = safeText(req.query.search, 80).toLowerCase();
    const inStockOnly = String(req.query.inStock || "") === "1";

    let rows = category && VALID_CATEGORIES.has(category)
      ? await all("SELECT * FROM products WHERE category = ? ORDER BY id", [category])
      : await all("SELECT * FROM products ORDER BY id");

    if (inStockOnly) rows = rows.filter((row) => Number(row.in_stock) === 1 && Number(row.stock_quantity || 0) > 0);
    if (search) {
      rows = rows.filter((row) => {
        const hay = `${row.name || ""} ${row.description || ""}`.toLowerCase();
        return hay.includes(search);
      });
    }

    res.json({ data: formatProducts(rows) });
  } catch {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.get("/api/products/:id/related", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid product id" });

    const current = await get("SELECT * FROM products WHERE id = ?", [id]);
    if (!current) return res.status(404).json({ error: "Product not found" });

    const rows = await all(
      "SELECT * FROM products WHERE category = ? AND id != ? AND in_stock = 1 ORDER BY RANDOM() LIMIT 4",
      [current.category, id]
    );

    res.json({ data: formatProducts(rows) });
  } catch {
    res.status(500).json({ error: "Failed to fetch related products" });
  }
});

app.get("/api/admin/products", requireAdmin, async (_, res) => {
  try {
    const rows = await all("SELECT * FROM products ORDER BY id DESC");
    res.json({ data: formatProducts(rows) });
  } catch {
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const { errors, data } = toProductPayload(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join(", ") });

    const result = await run(
      `INSERT INTO products (name, category, price, description, image_url, metadata, in_stock, stock_quantity, low_stock_threshold)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.category,
        data.price,
        data.description,
        data.image_url,
        data.metadata,
        data.in_stock,
        data.stock_quantity,
        data.low_stock_threshold,
      ]
    );

    const row = await get("SELECT * FROM products WHERE id = ?", [result.id]);
    res.status(201).json({ data: formatProducts([row])[0] });
  } catch {
    res.status(500).json({ error: "Failed to create product" });
  }
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: "Invalid product id" });

    const existing = await get("SELECT id FROM products WHERE id = ?", [productId]);
    if (!existing) return res.status(404).json({ error: "Product not found" });

    const { errors, data } = toProductPayload(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join(", ") });

    await run(
      `UPDATE products
       SET name = ?, category = ?, price = ?, description = ?, image_url = ?, metadata = ?, in_stock = ?, stock_quantity = ?, low_stock_threshold = ?
       WHERE id = ?`,
      [
        data.name,
        data.category,
        data.price,
        data.description,
        data.image_url,
        data.metadata,
        data.in_stock,
        data.stock_quantity,
        data.low_stock_threshold,
        productId,
      ]
    );

    const row = await get("SELECT * FROM products WHERE id = ?", [productId]);
    res.json({ data: formatProducts([row])[0] });
  } catch {
    res.status(500).json({ error: "Failed to update product" });
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: "Invalid product id" });

    const result = await run("DELETE FROM products WHERE id = ?", [productId]);
    if (result.changes === 0) return res.status(404).json({ error: "Product not found" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

app.post("/api/cart/sync", async (req, res) => {
  try {
    const sessionId = safeText(req.body?.sessionId, 120);
    const cart = Array.isArray(req.body?.cart) ? req.body.cart : null;
    if (!sessionId || !Array.isArray(cart)) {
      return res.status(400).json({ error: "sessionId and cart[] are required" });
    }
    const payload = JSON.stringify(cart.slice(0, 200));
    await run(
      `INSERT INTO cart_snapshots (session_id, payload, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload, updated_at=CURRENT_TIMESTAMP`,
      [sessionId, payload]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to sync cart" });
  }
});

app.get("/api/cart/snapshot/:sessionId", async (req, res) => {
  try {
    const sessionId = safeText(req.params.sessionId, 120);
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

    const snapshot = await get("SELECT payload, updated_at FROM cart_snapshots WHERE session_id = ?", [sessionId]);
    if (!snapshot) return res.json({ data: null });

    let cart = [];
    try {
      cart = JSON.parse(snapshot.payload || "[]");
    } catch {
      cart = [];
    }

    res.json({ data: { cart, updated_at: snapshot.updated_at } });
  } catch {
    res.status(500).json({ error: "Failed to load cart snapshot" });
  }
});

app.post("/api/orders/whatsapp", async (req, res) => {
  try {
    const { customer = {}, items } = req.body;
    if ((!customer?.name || !customer?.email) && !req.user) {
      return res.status(400).json({ error: "customer(name,email) and items are required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "customer(name,email) and items are required" });
    }

    const productIds = [...new Set(items.map((i) => Number(i.productId)).filter((id) => Number.isInteger(id) && id > 0))];
    if (productIds.length === 0) return res.status(400).json({ error: "No valid cart items" });

    const products = await all(
      `SELECT id, name, price FROM products WHERE id IN (${productIds.map(() => "?").join(",")})`,
      productIds
    );
    const productMap = new Map(products.map((p) => [p.id, p]));

    const { subtotalAmount, normalizedItems } = parseCartItems(items, productMap);
    if (normalizedItems.length === 0) return res.status(400).json({ error: "No valid cart items" });

    const delivery = await calculateDelivery({
      deliveryZoneCode: customer.deliveryZoneCode,
      cartSubtotal: subtotalAmount,
    });
    if (delivery.status !== 200) return res.status(delivery.status).json({ error: delivery.error });

    const reference = genRef();
    const customerName = safeText(customer.name || req.user?.name || "", MAX_INPUT_LENGTH.name);
    const customerEmail = normalizeEmail(safeText(customer.email || req.user?.email || "", MAX_INPUT_LENGTH.email));
    const customerPhone = safeText(customer.phone, MAX_INPUT_LENGTH.phone);
    const shippingAddress = safeText(customer.address, MAX_INPUT_LENGTH.address);
    const customerNotes = safeText(customer.notes, MAX_INPUT_LENGTH.notes);

    const orderResult = await run(
      `INSERT INTO orders (user_id, customer_name, customer_email, customer_phone, shipping_address, notes, amount, status, payment_reference, delivery_zone_code, delivery_zone_name, subtotal_amount, delivery_fee, grand_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)`,
      [
        req.user?.id || null,
        customerName,
        customerEmail,
        customerPhone,
        shippingAddress,
        customerNotes,
        delivery.grandTotal,
        reference,
        delivery.zone.code,
        delivery.zone.name,
        delivery.subtotal,
        delivery.deliveryFee,
        delivery.grandTotal,
      ]
    );

    for (const i of normalizedItems) {
      await run(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderResult.id, i.productId, i.productName, i.quantity, i.unitPrice, i.lineTotal]
      );
    }

    const createdOrderBundle = await fetchOrderWithItems(orderResult.id);

    if (createdOrderBundle) {
      Promise.resolve(notifyNewOrder(createdOrderBundle.order, createdOrderBundle.items)).catch(() => {});
    }

    res.status(201).json({
      data: {
        orderId: orderResult.id,
        reference,
        amount: delivery.grandTotal,
        subtotalAmount: delivery.subtotal,
        deliveryFee: delivery.deliveryFee,
        grandTotal: delivery.grandTotal,
        deliveryZoneCode: delivery.zone.code,
        deliveryZoneName: delivery.zone.name,
        items: normalizedItems,
        customerNotification: {
          channel: "async",
          fallback: null,
        },
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to create WhatsApp order" });
  }
});

app.post("/api/checkout/initialize", async (req, res) => {
  try {
    const { customer = {}, items } = req.body;
    if ((!customer?.name || !customer?.email) && !req.user) {
      return res.status(400).json({ error: "customer(name,email) and items are required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "customer(name,email) and items are required" });
    }

    const productIds = [...new Set(items.map((i) => Number(i.productId)).filter((id) => Number.isInteger(id) && id > 0))];
    if (productIds.length === 0) return res.status(400).json({ error: "No valid cart items" });

    const products = await all(
      `SELECT id, name, price FROM products WHERE id IN (${productIds.map(() => "?").join(",")})`,
      productIds
    );
    const productMap = new Map(products.map((p) => [p.id, p]));

    const { subtotalAmount, normalizedItems } = parseCartItems(items, productMap);
    if (normalizedItems.length === 0) return res.status(400).json({ error: "No valid cart items" });

    const delivery = await calculateDelivery({
      deliveryZoneCode: customer.deliveryZoneCode,
      cartSubtotal: subtotalAmount,
    });
    if (delivery.status !== 200) return res.status(delivery.status).json({ error: delivery.error });

    const reference = genRef();
    const customerName = safeText(customer.name || req.user?.name || "", MAX_INPUT_LENGTH.name);
    const customerEmail = normalizeEmail(safeText(customer.email || req.user?.email || "", MAX_INPUT_LENGTH.email));
    const customerPhone = safeText(customer.phone, MAX_INPUT_LENGTH.phone);
    const shippingAddress = safeText(customer.address, MAX_INPUT_LENGTH.address);
    const customerNotes = safeText(customer.notes, MAX_INPUT_LENGTH.notes);

    const orderResult = await run(
      `INSERT INTO orders (user_id, customer_name, customer_email, customer_phone, shipping_address, notes, amount, status, payment_reference, delivery_zone_code, delivery_zone_name, subtotal_amount, delivery_fee, grand_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?)`,
      [
        req.user?.id || null,
        customerName,
        customerEmail,
        customerPhone,
        shippingAddress,
        customerNotes,
        delivery.grandTotal,
        reference,
        delivery.zone.code,
        delivery.zone.name,
        delivery.subtotal,
        delivery.deliveryFee,
        delivery.grandTotal,
      ]
    );

    for (const i of normalizedItems) {
      await run(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderResult.id, i.productId, i.productName, i.quantity, i.unitPrice, i.lineTotal]
      );
    }

    const createdOrderBundle = await fetchOrderWithItems(orderResult.id);

    if (createdOrderBundle) {
      Promise.resolve(notifyNewOrder(createdOrderBundle.order, createdOrderBundle.items)).catch(() => {});
    }

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "PAYSTACK_SECRET_KEY missing" });
    }

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: customerEmail,
        amount: delivery.grandTotal * 100,
        reference,
        callback_url: `${BASE_URL}/checkout/success?reference=${reference}`,
        metadata: {
          orderId: orderResult.id,
          userId: req.user?.id || null,
          customerName,
          deliveryZoneCode: delivery.zone.code,
          deliveryFee: delivery.deliveryFee,
          subtotalAmount: delivery.subtotal,
          grandTotal: delivery.grandTotal,
        },
      }),
    });

    const data = await response.json();
    if (!data.status) {
      return res.status(502).json({ error: data.message || "Paystack init failed" });
    }

    await run("UPDATE orders SET paystack_access_code = ?, updated_at=CURRENT_TIMESTAMP WHERE id = ?", [
      data.data.access_code,
      orderResult.id,
    ]);

    res.json({
      status: true,
      data: {
        orderId: orderResult.id,
        reference,
        amount: delivery.grandTotal,
        subtotalAmount: delivery.subtotal,
        deliveryFee: delivery.deliveryFee,
        grandTotal: delivery.grandTotal,
        authorization_url: data.data.authorization_url,
        customerNotification: {
          channel: "async",
          fallback: null,
        },
      },
    });
  } catch {
    res.status(500).json({ error: "Checkout initialization failed" });
  }
});

app.get("/api/paystack/verify/:reference", async (req, res) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "PAYSTACK_SECRET_KEY missing" });
    }
    const reference = req.params.reference;
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const data = await response.json();

    if (data.status && data.data?.status === "success") {
      await run(
        `UPDATE orders
         SET status='paid', paid_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE payment_reference = ?`,
        [reference]
      );
    }

    res.json(data);
  } catch {
    res.status(500).json({ error: "Verification failed" });
  }
});

app.post("/api/paystack/webhook", async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return res.status(500).send("Missing webhook secret");

    const hash = crypto.createHmac("sha512", secret).update(req.body).digest("hex");
    const signature = req.headers["x-paystack-signature"];
    if (hash !== signature) return res.status(401).send("Invalid signature");

    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "charge.success") {
      const reference = event.data.reference;
      await run(
        `UPDATE orders
         SET status='paid', paid_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE payment_reference = ?`,
        [reference]
      );
    }

    return res.status(200).json({ received: true });
  } catch {
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.get("/api/orders/:reference", async (req, res) => {
  try {
    const order = await get("SELECT * FROM orders WHERE payment_reference = ?", [req.params.reference]);
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (order.user_id && (!req.user || req.user.id !== order.user_id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const items = await all("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
    res.json({ data: { ...order, items } });
  } catch {
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).trim() : "";
    if (status && !ORDER_STATUSES.has(status)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    const orders = status
      ? await all("SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC", [status])
      : await all("SELECT * FROM orders ORDER BY created_at DESC");

    const orderIds = orders.map((o) => o.id);
    const items = orderIds.length
      ? await all(
          `SELECT * FROM order_items WHERE order_id IN (${orderIds.map(() => "?").join(",")}) ORDER BY id DESC`,
          orderIds
        )
      : [];

    const itemsByOrderId = items.reduce((acc, item) => {
      if (!acc[item.order_id]) acc[item.order_id] = [];
      acc[item.order_id].push(item);
      return acc;
    }, {});

    const data = orders.map((o) => ({ ...o, items: itemsByOrderId[o.id] || [] }));
    res.json({ data });
  } catch {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const status = String(req.body?.status || "").trim();

    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: "Invalid order id" });
    if (!ORDER_STATUSES.has(status)) return res.status(400).json({ error: "Invalid order status" });

    const existing = await get("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!existing) return res.status(404).json({ error: "Order not found" });

    await run(
      `UPDATE orders
       SET status = ?,
           paid_at = CASE WHEN ? = 'paid' AND paid_at IS NULL THEN CURRENT_TIMESTAMP ELSE paid_at END,
           processing_at = CASE WHEN ? = 'processing' THEN CURRENT_TIMESTAMP ELSE processing_at END,
           delivered_at = CASE WHEN ? = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
           cancelled_at = CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, status, status, status, status, orderId]
    );

    const updated = await get("SELECT * FROM orders WHERE id = ?", [orderId]);
    const items = await all("SELECT * FROM order_items WHERE order_id = ?", [orderId]);
    Promise.resolve(notifyOrderStatusChanged(updated, existing.status, status)).catch(() => {});
    res.json({ data: { ...updated, items } });
  } catch {
    res.status(500).json({ error: "Failed to update order status" });
  }
});

app.get("/api/admin/notifications/logs", requireAdmin, async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || 50);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;

    const logs = await all(
      `SELECT nl.*, o.payment_reference
       FROM notification_logs nl
       LEFT JOIN orders o ON o.id = nl.order_id
       ORDER BY nl.created_at DESC, nl.id DESC
       LIMIT ?`,
      [limit]
    );

    res.json({ data: logs });
  } catch {
    res.status(500).json({ error: "Failed to fetch notification logs" });
  }
});

app.get("/api/admin/dashboard/metrics", requireAdmin, async (_, res) => {
  try {
    const [ordersCount, paidCount, revenue, productsCount, usersCount] = await Promise.all([
      get("SELECT COUNT(*) AS total FROM orders"),
      get("SELECT COUNT(*) AS total FROM orders WHERE status = 'paid'"),
      get("SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status IN ('paid','processing','delivered')"),
      get("SELECT COUNT(*) AS total FROM products"),
      get("SELECT COUNT(*) AS total FROM users"),
    ]);

    res.json({
      data: {
        totalOrders: ordersCount?.total || 0,
        paidOrders: paidCount?.total || 0,
        revenue: revenue?.total || 0,
        products: productsCount?.total || 0,
        users: usersCount?.total || 0,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

app.get("/api/admin/products/low-stock", requireAdmin, async (_, res) => {
  try {
    const rows = await fetchLowStockProducts();
    res.json({
      data: rows.map((row) => ({
        ...row,
        stock_quantity: Number(row.stock_quantity || 0),
        low_stock_threshold: Number(row.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD),
      })),
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch low-stock products" });
  }
});

app.get("/api/admin/products/low-stock-summary", requireAdmin, async (_, res) => {
  try {
    const summary = await getLowStockSummary();
    res.json({ data: summary });
  } catch {
    res.status(500).json({ error: "Failed to build low-stock summary" });
  }
});

app.post("/api/admin/products/low-stock-summary/run", requireAdmin, async (req, res) => {
  try {
    const summary = await getLowStockSummary();
    const result = await notifyAdminLowStockSummary(summary, { source: "manual_admin", actor: req.admin?.role || "admin" });
    res.json({ data: { summary, notification: result } });
  } catch {
    res.status(500).json({ error: "Failed to run low-stock summary" });
  }
});

app.post("/api/jobs/low-stock-summary/run", async (req, res) => {
  if (!hasInventoryJobAccess(req)) {
    return res.status(401).json({ error: "Unauthorized job trigger" });
  }

  try {
    const summary = await getLowStockSummary();
    const result = await notifyAdminLowStockSummary(summary, { source: "scheduler_job" });
    res.json({ ok: true, data: { summary, notification: result } });
  } catch {
    res.status(500).json({ error: "Failed to run scheduled low-stock summary" });
  }
});

app.get("/api/admin/orders/export.csv", requireAdmin, async (_, res) => {
  try {
    const rows = await all("SELECT * FROM orders ORDER BY created_at DESC");
    const headers = [
      "id",
      "payment_reference",
      "status",
      "customer_name",
      "customer_email",
      "customer_phone",
      "delivery_zone_name",
      "subtotal_amount",
      "delivery_fee",
      "grand_total",
      "amount",
      "currency",
      "created_at",
    ];
    const escape = (value = "") => `"${String(value).replaceAll('"', '""')}"`;
    const csv = [headers.join(",")]
      .concat(
        rows.map((row) => {
          const money = getOrderFinancials(row);
          const record = {
            ...row,
            subtotal_amount: money.subtotal,
            delivery_fee: money.deliveryFee,
            grand_total: money.grandTotal,
          };
          return headers.map((h) => escape(record[h] ?? "")).join(",");
        })
      )
      .join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orders-${Date.now()}.csv"`);
    res.send(csv);
  } catch {
    res.status(500).json({ error: "Failed to export orders" });
  }
});

app.get("/checkout", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "checkout.html"));
});

app.get("/checkout/success", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "success.html"));
});

app.get("/admin", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/login", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/signup", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "signup.html"));
});

["about", "terms", "privacy", "contact"].forEach((page) => {
  app.get(`/${page}`, (_, res) => {
    res.sendFile(path.join(__dirname, "public", `${page}.html`));
  });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Vicbest Store running on http://localhost:${PORT}`);
  });
});