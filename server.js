require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const bcrypt = require("bcrypt");
const express = require("express");
const path = require("path");
const { initDb, all, get, run, dbPath, getStartupWarnings } = require("./db");
const { notifyNewOrder, notifyOrderStatusChanged, notifyAdminLowStockSummary } = require("./notifications");
const { ensureAdvancedSchema, buildDeterministicAssistantReply, makeRestoreToken } = require("./advanced");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const VALID_CATEGORIES = new Set(["car", "grocery"]);
const ORDER_STATUSES = new Set(["pending_payment", "paid", "processing", "delivered", "cancelled"]);
const ADMIN_ORDER_STATUS_FILTERS = new Set(["new", "processing", "delivered", "cancelled"]);
const VALID_COUPON_TYPES = new Set(["fixed", "percent"]);
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
  couponCode: 40,
  internalNotes: 3000,
};
const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const UPLOADS_DIR = path.join(__dirname, "public", "uploads");
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const rateStore = new Map();

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use("/api/paystack/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "6mb" }));
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

function normalizeCategory(rawValue) {
  const value = safeText(rawValue, 80).toLowerCase();
  if (value === "cars") return "car";
  if (value === "groceries") return "grocery";
  return value;
}

function parseCartItems(items, productMap) {
  let subtotalAmount = 0;
  const normalizedItems = [];

  for (const item of items) {
    const product = productMap.get(Number(item.productId));
    const quantity = Number(item.quantity) || 1;
    if (!product || quantity <= 0) continue;
    if (Number(product.stock_quantity || 0) < quantity) continue;
    const lineTotal = product.price * quantity;
    subtotalAmount += lineTotal;
    normalizedItems.push({
      productId: product.id,
      productName: product.name,
      category: product.category,
      quantity,
      unitPrice: product.price,
      lineTotal,
    });
  }

  return { subtotalAmount, normalizedItems };
}

function parseProductIdsFromInput(rawValue) {
  const fromArray = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  return [...new Set(fromArray.map((x) => Number(x)).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 20);
}

function pickRecommendations(allProducts, seedProducts = [], limit = 6) {
  const seeds = seedProducts.filter(Boolean);
  const ids = new Set(seeds.map((p) => p.id));
  const categories = new Set(seeds.map((p) => p.category).filter(Boolean));

  const scored = allProducts
    .filter((p) => !ids.has(p.id) && Number(p.in_stock) === 1)
    .map((p) => {
      let score = 0;
      if (categories.has(p.category)) score += 10;
      const nearest = seeds.length
        ? Math.min(...seeds.map((seed) => Math.abs(Number(seed.price || 0) - Number(p.price || 0))))
        : Number(p.price || 0);
      score += Math.max(0, 8 - Math.floor(nearest / 2000000));
      score += Math.max(0, 4 - Math.floor(Number(p.stock_quantity || 0) / 5));
      return { ...p, _score: score };
    })
    .sort((a, b) => b._score - a._score || a.price - b.price || b.id - a.id)
    .slice(0, limit);

  return scored.map(({ _score, ...rest }) => rest);
}

function parseCsvRows(raw = "") {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ',') {
      row.push(field);
      field = "";
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(field);
      if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const records = rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, idx) => {
      record[header] = String(cells[idx] || "").trim();
    });
    return record;
  });

  return { headers, records };
}

function parseBooleanLike(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function toCouponCode(value = "") {
  return safeText(value, MAX_INPUT_LENGTH.couponCode).replace(/\s+/g, "").toUpperCase();
}

async function validateAndApplyCoupon(rawCode, subtotalAmount, customerEmail = "") {
  const code = toCouponCode(rawCode);
  if (!code) {
    return { valid: true, discountAmount: 0, coupon: null };
  }

  const subtotal = Number(subtotalAmount);
  if (!Number.isInteger(subtotal) || subtotal < 0) {
    return { valid: false, error: "Invalid subtotal for coupon validation" };
  }

  const coupon = await get("SELECT * FROM coupons WHERE UPPER(code) = UPPER(?)", [code]);
  if (!coupon) return { valid: false, error: "Coupon not found" };
  if (Number(coupon.is_active) !== 1) return { valid: false, error: "Coupon is inactive" };

  const now = Date.now();
  const startsAt = coupon.starts_at ? Date.parse(coupon.starts_at) : null;
  const endsAt = coupon.ends_at ? Date.parse(coupon.ends_at) : null;

  if (startsAt && Number.isFinite(startsAt) && now < startsAt) return { valid: false, error: "Coupon is not active yet" };
  if (endsAt && Number.isFinite(endsAt) && now > endsAt) return { valid: false, error: "Coupon has expired" };

  const usageLimit = coupon.usage_limit !== null && coupon.usage_limit !== undefined ? Number(coupon.usage_limit) : null;
  if (usageLimit !== null && Number.isInteger(usageLimit) && usageLimit >= 0 && Number(coupon.used_count || 0) >= usageLimit) {
    return { valid: false, error: "Coupon usage limit reached" };
  }

  const minOrder = coupon.min_order_amount !== null && coupon.min_order_amount !== undefined ? Number(coupon.min_order_amount) : null;
  if (minOrder !== null && Number.isFinite(minOrder) && subtotal < minOrder) {
    return { valid: false, error: `Coupon requires minimum order of ₦${minOrder.toLocaleString("en-NG")}` };
  }

  const discountType = String(coupon.discount_type || "").toLowerCase();
  let discountAmount = 0;
  if (discountType === "fixed") discountAmount = Number(coupon.discount_value || 0);
  else if (discountType === "percent") discountAmount = Math.floor((subtotal * Number(coupon.discount_value || 0)) / 100);
  else return { valid: false, error: "Unsupported coupon type" };

  const maxDiscount = coupon.max_discount_amount !== null && coupon.max_discount_amount !== undefined ? Number(coupon.max_discount_amount) : null;
  if (maxDiscount !== null && Number.isFinite(maxDiscount) && maxDiscount >= 0) {
    discountAmount = Math.min(discountAmount, maxDiscount);
  }
  discountAmount = Math.max(0, Math.min(discountAmount, subtotal));

  const usageByEmail = customerEmail
    ? await get("SELECT COUNT(*) AS total FROM coupon_usages WHERE coupon_id = ? AND LOWER(customer_email) = LOWER(?)", [coupon.id, customerEmail])
    : { total: 0 };

  return {
    valid: true,
    coupon,
    discountAmount,
    usageByEmail: usageByEmail?.total || 0,
  };
}

async function addOrderTimelineEvent(orderId, eventType, message, actor = "system", payload = null) {
  if (!orderId) return;
  await run(
    `INSERT INTO order_timeline_events (order_id, event_type, message, actor, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, safeText(eventType, 80), safeText(message, 1000), safeText(actor, 80), payload ? JSON.stringify(payload) : null]
  );
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
  const hasDiscount = order.discount_amount !== null && order.discount_amount !== undefined && order.discount_amount !== "";

  const subtotal = hasSubtotal ? Number(order.subtotal_amount) : Number(order.amount || 0);
  const deliveryFee = hasDeliveryFee ? Number(order.delivery_fee) : 0;
  const discountAmount = hasDiscount ? Number(order.discount_amount) : 0;
  const grandTotal = hasGrandTotal ? Number(order.grand_total) : Number(order.amount || subtotal + deliveryFee - discountAmount);
  return { subtotal, deliveryFee, discountAmount, grandTotal };
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
  const category = normalizeCategory(body.category);
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
  if (!category) errors.push("category is required");
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

function buildAdminOrderFilters(rawStatusFilter, rawSearch) {
  const statusFilter = rawStatusFilter ? String(rawStatusFilter).trim().toLowerCase() : "";
  const search = safeText(rawSearch, 120).toLowerCase();

  if (statusFilter && !ADMIN_ORDER_STATUS_FILTERS.has(statusFilter) && !ORDER_STATUSES.has(statusFilter)) {
    return { error: "Invalid status filter" };
  }

  let statuses = [];
  if (statusFilter === "new") statuses = ["pending_payment", "paid"];
  else if (statusFilter) statuses = [statusFilter];

  return { statuses, search };
}

function roleRank(role = "") {
  const map = { inventory_staff: 1, manager: 2, super_admin: 3, admin: 3 };
  return map[role] || 0;
}

function requireAdminRole(minRole = "manager") {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: "Unauthorized" });
    if (roleRank(req.admin.role) < roleRank(minRole)) return res.status(403).json({ error: "Insufficient role" });
    next();
  };
}

async function writeAuditLog(req, action, entityType, entityId, metadata = {}) {
  try {
    await run(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_role, action, entity_type, entity_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.admin ? "admin" : "system", String(req.admin?.id || "system"), String(req.admin?.role || "system"), action, entityType, String(entityId || ""), JSON.stringify(metadata || {})]
    );
  } catch {}
}

async function applyPromoRules({ items, subtotalAmount }) {
  const nowIso = new Date().toISOString();
  const rules = await all(
    `SELECT * FROM promo_rules
     WHERE is_active = 1
     AND (starts_at IS NULL OR starts_at <= ?)
     AND (ends_at IS NULL OR ends_at >= ?)
     ORDER BY id DESC`,
    [nowIso, nowIso]
  );

  const breakdown = [];
  let promoDiscount = 0;
  const appliedRuleIds = [];

  for (const rule of rules) {
    const minCart = Number(rule.min_cart_amount || 0);
    if (subtotalAmount < minCart) continue;

    const categoryMatch = rule.category
      ? items.some((i) => normalizeCategory(i.category || "") === normalizeCategory(rule.category || ""))
      : true;
    if (!categoryMatch) continue;

    let thisDiscount = 0;
    if (rule.rule_type === "discount") {
      if (rule.discount_type === "fixed") thisDiscount = Number(rule.discount_value || 0);
      if (rule.discount_type === "percent") thisDiscount = Math.floor((subtotalAmount * Number(rule.discount_value || 0)) / 100);
    }

    if (rule.rule_type === "bogo" && Number(rule.bogo_product_id) > 0) {
      const item = items.find((i) => Number(i.productId) === Number(rule.bogo_product_id));
      if (item) {
        const buyQty = Math.max(1, Number(rule.bogo_buy_qty || 1));
        const getQty = Math.max(1, Number(rule.bogo_get_qty || 1));
        const freeUnits = Math.floor(item.quantity / buyQty) * getQty;
        thisDiscount = freeUnits * Number(item.unitPrice || 0);
      }
    }

    thisDiscount = Math.max(0, Math.min(thisDiscount, subtotalAmount - promoDiscount));
    if (thisDiscount > 0) {
      promoDiscount += thisDiscount;
      appliedRuleIds.push(rule.id);
      breakdown.push({ ruleId: rule.id, name: rule.name, discountAmount: thisDiscount, type: rule.rule_type });
    }
  }

  return { promoDiscount, appliedRuleIds, breakdown };
}

function computeRiskScore({ customerEmail, customerPhone, amount, isGuest }) {
  let score = 0;
  const flags = [];
  if (isGuest) {
    score += 20;
    flags.push("guest_checkout");
  }
  if (!String(customerPhone || "").trim()) {
    score += 15;
    flags.push("missing_phone");
  }
  if (Number(amount || 0) > Number(process.env.FRAUD_HIGH_AMOUNT || 1500000)) {
    score += 35;
    flags.push("high_amount");
  }
  if (!String(customerEmail || "").includes("@")) {
    score += 20;
    flags.push("suspicious_email");
  }

  const reviewThreshold = Number(process.env.FRAUD_REVIEW_THRESHOLD || 45);
  const riskLevel = score >= 70 ? "high" : score >= reviewThreshold ? "medium" : "low";
  const manualReviewStatus = riskLevel === "high" || riskLevel === "medium" ? "queued" : "clear";
  return { score, riskLevel, flags, manualReviewStatus };
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

app.post("/api/admin/login", rateLimit({ windowMs: 60_000, maxRequests: 12 }), async (req, res) => {
  try {
    const email = normalizeEmail(safeText(req.body?.email, 160));
    const password = String(req.body?.password || "");

    if (email) {
      const admin = await get("SELECT * FROM admin_users WHERE email = ? AND is_active = 1", [email]);
      if (!admin) return res.status(401).json({ error: "Invalid credentials" });
      const ok = await bcrypt.compare(password, admin.password_hash);
      if (!ok) return res.status(401).json({ error: "Invalid credentials" });
      const token = signAdminToken({ id: admin.id, role: admin.role || "manager", exp: Date.now() + 12 * 60 * 60 * 1000 });
      return res.json({ token, expiresInHours: 12, role: admin.role || "manager" });
    }

    const configuredPassword = process.env.ADMIN_PASSWORD;
    if (!configuredPassword) return res.status(500).json({ error: "ADMIN_PASSWORD is not configured" });
    if (!password || password !== configuredPassword) return res.status(401).json({ error: "Invalid credentials" });

    const token = signAdminToken({ id: "legacy", role: "super_admin", exp: Date.now() + 12 * 60 * 60 * 1000 });
    return res.json({ token, expiresInHours: 12, role: "super_admin" });
  } catch {
    return res.status(500).json({ error: "Admin login failed" });
  }
});

app.post("/api/admin/uploads/product-image", requireAdmin, rateLimit({ windowMs: 60_000, maxRequests: 20 }), async (req, res) => {
  try {
    const fileName = safeText(req.body?.fileName, 150) || "product-image";
    const dataUrl = String(req.body?.dataUrl || "");

    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: "Invalid image payload" });

    const mimeType = String(match[1]).toLowerCase();
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
      return res.status(400).json({ error: "Only JPG, PNG, WEBP, and GIF are supported" });
    }

    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length) return res.status(400).json({ error: "Image is empty" });
    if (bytes.length > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: `Image too large. Max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB` });
    }

    const extensionByMime = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
    };
    const ext = extensionByMime[mimeType] || path.extname(fileName).toLowerCase() || ".jpg";
    const outputName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
    const outputPath = path.join(UPLOADS_DIR, outputName);

    await fs.promises.writeFile(outputPath, bytes);
    return res.status(201).json({ data: { image_url: `/uploads/${outputName}` } });
  } catch {
    return res.status(500).json({ error: "Image upload failed" });
  }
});

app.get("/api/home/highlights", async (_, res) => {
  try {
    const [allProducts, topDeals, recentlyAdded, popularRows, deliveredCount] = await Promise.all([
      all("SELECT * FROM products ORDER BY id"),
      all("SELECT * FROM products WHERE in_stock = 1 ORDER BY price ASC LIMIT 6"),
      all("SELECT * FROM products ORDER BY created_at DESC, id DESC LIMIT 6"),
      all(
        `SELECT p.*, COALESCE(SUM(oi.quantity), 0) AS order_qty
         FROM products p
         LEFT JOIN order_items oi ON oi.product_id = p.id
         LEFT JOIN orders o ON o.id = oi.order_id
         AND o.status IN ('paid','processing','delivered')
         AND datetime(o.created_at) >= datetime('now', '-7 day')
         GROUP BY p.id
         ORDER BY order_qty DESC, p.id DESC
         LIMIT 6`
      ),
      get("SELECT COUNT(*) AS total FROM orders WHERE status = 'delivered'"),
    ]);

    const popularThisWeek = popularRows.filter((row) => Number(row.order_qty || 0) > 0);
    const fallbackPopular = allProducts.filter((p) => Number(p.in_stock) === 1).slice(0, 6);

    res.json({
      data: {
        featured: {
          topDeals: formatProducts(topDeals),
          recentlyAdded: formatProducts(recentlyAdded),
          popularThisWeek: formatProducts(popularThisWeek.length ? popularThisWeek : fallbackPopular),
        },
        socialProof: {
          ordersDelivered: Number(deliveredCount?.total || 0),
          testimonials: [
            { quote: "“Very transparent process and smooth delivery.”", by: "Chika, Lagos" },
            { quote: "“Got my groceries same day. Fresh and neatly packed.”", by: "Tunde, Ikeja" },
            { quote: "“The car condition matched exactly what was posted.”", by: "Ada, Abuja" },
          ],
        },
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch homepage highlights" });
  }
});

app.get("/api/home/flash-deals", async (_, res) => {
  try {
    const rows = await all(
      `SELECT * FROM products
       WHERE in_stock = 1
       ORDER BY price ASC, stock_quantity ASC, id DESC
       LIMIT 6`
    );

    const endsAt = new Date(Date.now() + 1000 * 60 * 60 * 6).toISOString();
    res.json({ data: { endsAt, products: formatProducts(rows) } });
  } catch {
    res.status(500).json({ error: "Failed to load flash deals" });
  }
});

app.get("/api/recommendations", async (req, res) => {
  try {
    const productIds = parseProductIdsFromInput(req.query.productIds);
    const allProducts = await all("SELECT * FROM products ORDER BY id DESC");
    let seeds = [];

    if (productIds.length) {
      const placeholders = productIds.map(() => "?").join(",");
      seeds = await all(`SELECT * FROM products WHERE id IN (${placeholders})`, productIds);
    }

    if (!seeds.length && req.user) {
      seeds = await all(
        `SELECT p.*
         FROM user_recently_viewed rv
         JOIN products p ON p.id = rv.product_id
         WHERE rv.user_id = ?
         ORDER BY rv.viewed_at DESC
         LIMIT 6`,
        [req.user.id]
      );
    }

    const picks = pickRecommendations(allProducts, seeds, 6);
    res.json({ data: formatProducts(picks) });
  } catch {
    res.status(500).json({ error: "Failed to load recommendations" });
  }
});

app.get("/api/me/wishlist", requireUser, async (req, res) => {
  try {
    const rows = await all(
      `SELECT p.*
       FROM wishlists w
       JOIN products p ON p.id = w.product_id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    res.json({ data: formatProducts(rows) });
  } catch {
    res.status(500).json({ error: "Failed to load wishlist" });
  }
});

app.post("/api/me/wishlist", requireUser, async (req, res) => {
  try {
    const productId = Number(req.body?.productId);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: "Invalid productId" });

    const exists = await get("SELECT id FROM wishlists WHERE user_id = ? AND product_id = ?", [req.user.id, productId]);
    if (exists) {
      await run("DELETE FROM wishlists WHERE user_id = ? AND product_id = ?", [req.user.id, productId]);
      return res.json({ data: { productId, wished: false } });
    }

    await run(
      `INSERT INTO wishlists (user_id, product_id, created_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, product_id) DO NOTHING`,
      [req.user.id, productId]
    );

    return res.status(201).json({ data: { productId, wished: true } });
  } catch {
    return res.status(500).json({ error: "Failed to update wishlist" });
  }
});

app.get("/api/me/recently-viewed", requireUser, async (req, res) => {
  try {
    const rows = await all(
      `SELECT p.*
       FROM user_recently_viewed rv
       JOIN products p ON p.id = rv.product_id
       WHERE rv.user_id = ?
       ORDER BY rv.viewed_at DESC
       LIMIT 12`,
      [req.user.id]
    );
    res.json({ data: formatProducts(rows) });
  } catch {
    res.status(500).json({ error: "Failed to load recently viewed" });
  }
});

app.post("/api/me/recently-viewed", requireUser, async (req, res) => {
  try {
    const productId = Number(req.body?.productId);
    if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: "Invalid productId" });

    await run(
      `INSERT INTO user_recently_viewed (user_id, product_id, viewed_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, product_id) DO UPDATE SET viewed_at = CURRENT_TIMESTAMP`,
      [req.user.id, productId]
    );

    const overflow = await all(
      `SELECT id FROM user_recently_viewed
       WHERE user_id = ?
       ORDER BY viewed_at DESC
       LIMIT -1 OFFSET 20`,
      [req.user.id]
    );
    for (const row of overflow) {
      await run("DELETE FROM user_recently_viewed WHERE id = ?", [row.id]);
    }

    res.status(201).json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to save recently viewed" });
  }
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
    await writeAuditLog(req, "product.create", "product", result.id, { name: row?.name, category: row?.category });
    res.status(201).json({ data: formatProducts([row])[0] });
  } catch {
    res.status(500).json({ error: "Failed to create product" });
  }
});

app.post("/api/admin/products/bulk-upload", requireAdmin, async (req, res) => {
  try {
    const csvText = String(req.body?.csv || "");
    if (!csvText.trim()) return res.status(400).json({ error: "CSV content is required" });

    const { headers, records } = parseCsvRows(csvText);
    const requiredColumns = ["name", "category", "price"];
    const missing = requiredColumns.filter((col) => !headers.includes(col));
    if (missing.length) {
      return res.status(400).json({ error: `Missing required column(s): ${missing.join(", ")}` });
    }

    const report = [];
    for (let index = 0; index < records.length; index += 1) {
      const rowNumber = index + 2;
      const row = records[index];

      const payload = {
        name: row.name,
        category: normalizeCategory(row.category),
        price: Number(row.price),
        description: row.description || "",
        image_url: row.image_url || row.image || "",
        in_stock: parseBooleanLike(row.in_stock, true),
        stock_quantity: row.stock_quantity === "" ? 10 : Number(row.stock_quantity),
        low_stock_threshold: row.low_stock_threshold === "" ? DEFAULT_LOW_STOCK_THRESHOLD : Number(row.low_stock_threshold),
        metadata: {},
      };

      if (row.metadata) {
        try {
          payload.metadata = JSON.parse(row.metadata);
        } catch {
          report.push({ row: rowNumber, success: false, error: "Invalid metadata JSON" });
          continue;
        }
      } else {
        const metadata = {};
        ["mileage", "fuel", "transmission", "unit", "brand", "model", "year"].forEach((field) => {
          if (row[field]) metadata[field] = row[field];
        });
        payload.metadata = metadata;
      }

      const { errors, data } = toProductPayload(payload);
      if (errors.length > 0) {
        report.push({ row: rowNumber, success: false, error: errors.join(", ") });
        continue;
      }

      try {
        const byId = row.id ? await get("SELECT id FROM products WHERE id = ?", [Number(row.id)]) : null;
        const byName = await get("SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND category = ?", [data.name, data.category]);
        const existing = byId || byName;

        if (existing) {
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
              existing.id,
            ]
          );
          report.push({ row: rowNumber, success: true, action: "updated", productId: existing.id, name: data.name });
        } else {
          const created = await run(
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
          report.push({ row: rowNumber, success: true, action: "created", productId: created.id, name: data.name });
        }
      } catch (err) {
        report.push({ row: rowNumber, success: false, error: err.message || "Database error" });
      }
    }

    return res.json({
      data: {
        totalRows: records.length,
        successes: report.filter((x) => x.success).length,
        failures: report.filter((x) => !x.success).length,
        report,
      },
    });
  } catch {
    return res.status(500).json({ error: "Bulk upload failed" });
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
    await writeAuditLog(req, "product.update", "product", productId, { name: row?.name, category: row?.category });
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
    await writeAuditLog(req, "product.delete", "product", productId, {});
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to delete product" });
  }
});

app.get("/api/admin/coupons", requireAdmin, async (_, res) => {
  try {
    const rows = await all("SELECT * FROM coupons ORDER BY created_at DESC, id DESC");
    res.json({ data: rows });
  } catch {
    res.status(500).json({ error: "Failed to fetch coupons" });
  }
});

app.post("/api/admin/coupons", requireAdmin, async (req, res) => {
  try {
    const code = toCouponCode(req.body?.code);
    const discountType = safeText(req.body?.discount_type, 20).toLowerCase();
    const discountValue = Number(req.body?.discount_value);
    const description = safeText(req.body?.description, 300);
    const minOrderAmount = req.body?.min_order_amount === "" || req.body?.min_order_amount === undefined ? null : Number(req.body?.min_order_amount);
    const maxDiscountAmount = req.body?.max_discount_amount === "" || req.body?.max_discount_amount === undefined ? null : Number(req.body?.max_discount_amount);
    const usageLimit = req.body?.usage_limit === "" || req.body?.usage_limit === undefined ? null : Number(req.body?.usage_limit);
    const startsAt = safeText(req.body?.starts_at, 40) || null;
    const endsAt = safeText(req.body?.ends_at, 40) || null;
    const isActive = req.body?.is_active === undefined ? 1 : (req.body?.is_active ? 1 : 0);

    if (!code) return res.status(400).json({ error: "Coupon code is required" });
    if (!VALID_COUPON_TYPES.has(discountType)) return res.status(400).json({ error: "discount_type must be fixed or percent" });
    if (!Number.isInteger(discountValue) || discountValue <= 0) return res.status(400).json({ error: "discount_value must be a positive integer" });
    if (discountType === "percent" && discountValue > 100) return res.status(400).json({ error: "percent coupon cannot exceed 100" });

    const existing = await get("SELECT id FROM coupons WHERE UPPER(code) = UPPER(?)", [code]);
    if (existing) {
      await run(
        `UPDATE coupons SET description=?, discount_type=?, discount_value=?, min_order_amount=?, max_discount_amount=?, starts_at=?, ends_at=?, usage_limit=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
        [description, discountType, discountValue, minOrderAmount, maxDiscountAmount, startsAt, endsAt, usageLimit, isActive, existing.id]
      );
      const updated = await get("SELECT * FROM coupons WHERE id = ?", [existing.id]);
      return res.json({ data: updated });
    }

    const created = await run(
      `INSERT INTO coupons (code, description, discount_type, discount_value, min_order_amount, max_discount_amount, starts_at, ends_at, usage_limit, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [code, description, discountType, discountValue, minOrderAmount, maxDiscountAmount, startsAt, endsAt, usageLimit, isActive]
    );
    const row = await get("SELECT * FROM coupons WHERE id = ?", [created.id]);
    res.status(201).json({ data: row });
  } catch {
    res.status(500).json({ error: "Failed to save coupon" });
  }
});

app.post("/api/coupons/validate", async (req, res) => {
  try {
    const code = req.body?.code;
    const subtotalAmount = Number(req.body?.subtotalAmount || 0);
    if (!code) return res.status(400).json({ error: "Coupon code is required" });

    const result = await validateAndApplyCoupon(code, subtotalAmount, normalizeEmail(req.body?.customerEmail || req.user?.email || ""));
    if (!result.valid) return res.status(400).json({ error: result.error });

    const discountedSubtotal = Math.max(0, subtotalAmount - Number(result.discountAmount || 0));
    res.json({
      data: {
        code: result.coupon?.code || toCouponCode(code),
        discountAmount: Number(result.discountAmount || 0),
        discountedSubtotal,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to validate coupon" });
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
    const customerEmail = normalizeEmail(safeText(req.body?.customer?.email, MAX_INPUT_LENGTH.email));
    const customerPhone = safeText(req.body?.customer?.phone, MAX_INPUT_LENGTH.phone);
    const restoreToken = makeRestoreToken();
    await run(
      `INSERT INTO cart_snapshots (session_id, payload, customer_email, customer_phone, restore_token, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload, customer_email=COALESCE(excluded.customer_email, cart_snapshots.customer_email), customer_phone=COALESCE(excluded.customer_phone, cart_snapshots.customer_phone), restore_token=COALESCE(cart_snapshots.restore_token, excluded.restore_token), updated_at=CURRENT_TIMESTAMP`,
      [sessionId, payload, customerEmail || null, customerPhone || null, restoreToken]
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
      `SELECT id, name, category, price, stock_quantity FROM products WHERE id IN (${productIds.map(() => "?").join(",")})`,
      productIds
    );
    const productMap = new Map(products.map((p) => [p.id, p]));

    const { subtotalAmount, normalizedItems } = parseCartItems(items, productMap);
    if (normalizedItems.length === 0) return res.status(400).json({ error: "No valid cart items" });

    const couponResult = await validateAndApplyCoupon(
      customer.couponCode,
      subtotalAmount,
      normalizeEmail(customer.email || req.user?.email || "")
    );
    if (!couponResult.valid) return res.status(400).json({ error: couponResult.error });

    const reference = genRef();
    const customerName = safeText(customer.name || req.user?.name || "", MAX_INPUT_LENGTH.name);
    const customerEmail = normalizeEmail(safeText(customer.email || req.user?.email || "", MAX_INPUT_LENGTH.email));
    const customerPhone = safeText(customer.phone, MAX_INPUT_LENGTH.phone);
    const shippingAddress = safeText(customer.address, MAX_INPUT_LENGTH.address);
    const customerNotes = safeText(customer.notes, MAX_INPUT_LENGTH.notes);

    const promo = await applyPromoRules({ items: normalizedItems, subtotalAmount });
    const discountedSubtotal = Math.max(0, subtotalAmount - Number(couponResult.discountAmount || 0) - Number(promo.promoDiscount || 0));
    const pricedDelivery = await calculateDelivery({ deliveryZoneCode: customer.deliveryZoneCode, cartSubtotal: discountedSubtotal });
    if (pricedDelivery.status !== 200) return res.status(pricedDelivery.status).json({ error: pricedDelivery.error });
    const risk = computeRiskScore({ customerEmail, customerPhone, amount: pricedDelivery.grandTotal, isGuest: !req.user });

    const orderResult = await run(
      `INSERT INTO orders (user_id, customer_name, customer_email, customer_phone, shipping_address, notes, amount, status, payment_reference, delivery_zone_code, delivery_zone_name, subtotal_amount, delivery_fee, discount_amount, promo_discount_amount, promo_rule_ids, coupon_code, coupon_id, grand_total, risk_score, risk_level, risk_flags, manual_review_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user?.id || null,
        customerName,
        customerEmail,
        customerPhone,
        shippingAddress,
        customerNotes,
        pricedDelivery.grandTotal,
        reference,
        pricedDelivery.zone.code,
        pricedDelivery.zone.name,
        subtotalAmount,
        pricedDelivery.deliveryFee,
        Number(couponResult.discountAmount || 0),
        Number(promo.promoDiscount || 0),
        promo.appliedRuleIds.length ? JSON.stringify(promo.appliedRuleIds) : null,
        couponResult.coupon?.code || null,
        couponResult.coupon?.id || null,
        pricedDelivery.grandTotal,
        risk.score,
        risk.riskLevel,
        JSON.stringify(risk.flags),
        risk.manualReviewStatus,
      ]
    );

    if (couponResult.coupon?.id) {
      await run(`INSERT INTO coupon_usages (coupon_id, order_id, customer_email) VALUES (?, ?, ?)`, [couponResult.coupon.id, orderResult.id, customerEmail]);
      await run(`UPDATE coupons SET used_count = used_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [couponResult.coupon.id]);
    }

    await addOrderTimelineEvent(orderResult.id, "order_created", "Order created via WhatsApp checkout", "system", {
      status: "processing",
      couponCode: couponResult.coupon?.code || null,
    });

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
        amount: pricedDelivery.grandTotal,
        subtotalAmount,
        discountAmount: Number(couponResult.discountAmount || 0),
        promoDiscountAmount: Number(promo.promoDiscount || 0),
        couponCode: couponResult.coupon?.code || null,
        deliveryFee: pricedDelivery.deliveryFee,
        grandTotal: pricedDelivery.grandTotal,
        deliveryZoneCode: pricedDelivery.zone.code,
        deliveryZoneName: pricedDelivery.zone.name,
        riskLevel: risk.riskLevel,
        trackingUrl: `${BASE_URL}/track/${reference}`,
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
      `SELECT id, name, category, price, stock_quantity FROM products WHERE id IN (${productIds.map(() => "?").join(",")})`,
      productIds
    );
    const productMap = new Map(products.map((p) => [p.id, p]));

    const { subtotalAmount, normalizedItems } = parseCartItems(items, productMap);
    if (normalizedItems.length === 0) return res.status(400).json({ error: "No valid cart items" });

    const couponResult = await validateAndApplyCoupon(
      customer.couponCode,
      subtotalAmount,
      normalizeEmail(customer.email || req.user?.email || "")
    );
    if (!couponResult.valid) return res.status(400).json({ error: couponResult.error });

    const promo = await applyPromoRules({ items: normalizedItems, subtotalAmount });
    const discountedSubtotal = Math.max(0, subtotalAmount - Number(couponResult.discountAmount || 0) - Number(promo.promoDiscount || 0));
    const delivery = await calculateDelivery({
      deliveryZoneCode: customer.deliveryZoneCode,
      cartSubtotal: discountedSubtotal,
    });
    if (delivery.status !== 200) return res.status(delivery.status).json({ error: delivery.error });
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "PAYSTACK_SECRET_KEY missing" });
    }

    const reference = genRef();
    const customerName = safeText(customer.name || req.user?.name || "", MAX_INPUT_LENGTH.name);
    const customerEmail = normalizeEmail(safeText(customer.email || req.user?.email || "", MAX_INPUT_LENGTH.email));
    const customerPhone = safeText(customer.phone, MAX_INPUT_LENGTH.phone);
    const shippingAddress = safeText(customer.address, MAX_INPUT_LENGTH.address);
    const customerNotes = safeText(customer.notes, MAX_INPUT_LENGTH.notes);

    const risk = computeRiskScore({ customerEmail, customerPhone, amount: delivery.grandTotal, isGuest: !req.user });
    const orderResult = await run(
      `INSERT INTO orders (user_id, customer_name, customer_email, customer_phone, shipping_address, notes, amount, status, payment_reference, delivery_zone_code, delivery_zone_name, subtotal_amount, delivery_fee, discount_amount, promo_discount_amount, promo_rule_ids, coupon_code, coupon_id, grand_total, risk_score, risk_level, risk_flags, manual_review_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        subtotalAmount,
        delivery.deliveryFee,
        Number(couponResult.discountAmount || 0),
        Number(promo.promoDiscount || 0),
        promo.appliedRuleIds.length ? JSON.stringify(promo.appliedRuleIds) : null,
        couponResult.coupon?.code || null,
        couponResult.coupon?.id || null,
        delivery.grandTotal,
        risk.score,
        risk.riskLevel,
        JSON.stringify(risk.flags),
        risk.manualReviewStatus,
      ]
    );

    if (couponResult.coupon?.id) {
      await run(`INSERT INTO coupon_usages (coupon_id, order_id, customer_email) VALUES (?, ?, ?)`, [couponResult.coupon.id, orderResult.id, customerEmail]);
      await run(`UPDATE coupons SET used_count = used_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [couponResult.coupon.id]);
    }

    await addOrderTimelineEvent(orderResult.id, "order_created", "Order created via card checkout", "system", {
      status: "pending_payment",
      couponCode: couponResult.coupon?.code || null,
    });

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
          subtotalAmount,
          discountAmount: Number(couponResult.discountAmount || 0),
          couponCode: couponResult.coupon?.code || null,
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
        subtotalAmount,
        discountAmount: Number(couponResult.discountAmount || 0),
        promoDiscountAmount: Number(promo.promoDiscount || 0),
        couponCode: couponResult.coupon?.code || null,
        deliveryFee: delivery.deliveryFee,
        grandTotal: delivery.grandTotal,
        trackingUrl: `${BASE_URL}/track/${reference}`,
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
      const paidOrder = await get("SELECT id FROM orders WHERE payment_reference = ?", [reference]);
      if (paidOrder?.id) await addOrderTimelineEvent(paidOrder.id, "status_changed", "Payment confirmed. Status updated to paid", "system");
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
      const paidOrder = await get("SELECT id FROM orders WHERE payment_reference = ?", [reference]);
      if (paidOrder?.id) await addOrderTimelineEvent(paidOrder.id, "status_changed", "Payment confirmed by webhook", "system");
    }

    return res.status(200).json({ received: true });
  } catch {
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.get("/api/orders/track/:reference", async (req, res) => {
  try {
    const order = await get("SELECT id, payment_reference, status, customer_name, delivery_zone_name, delivery_zone_code, subtotal_amount, delivery_fee, discount_amount, grand_total, amount, created_at, updated_at FROM orders WHERE payment_reference = ?", [req.params.reference]);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const items = await all("SELECT product_name, quantity, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY id ASC", [order.id]);
    const timeline = await all("SELECT event_type, message, actor, created_at FROM order_timeline_events WHERE order_id = ? ORDER BY id DESC LIMIT 20", [order.id]);
    const money = getOrderFinancials(order);
    res.json({ data: { ...order, ...money, items, timeline } });
  } catch {
    res.status(500).json({ error: "Failed to fetch tracking details" });
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
    const { statuses, search, error } = buildAdminOrderFilters(req.query.status, req.query.search);
    if (error) return res.status(400).json({ error });

    const where = [];
    const params = [];

    if (statuses.length === 1) {
      where.push("status = ?");
      params.push(statuses[0]);
    } else if (statuses.length > 1) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }

    if (search) {
      where.push(`(
        LOWER(COALESCE(payment_reference, '')) LIKE ? OR
        LOWER(COALESCE(customer_name, '')) LIKE ? OR
        LOWER(COALESCE(customer_email, '')) LIKE ? OR
        CAST(id AS TEXT) LIKE ?
      )`);
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    const sql = `SELECT * FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC`;
    const orders = await all(sql, params);

    const orderIds = orders.map((o) => o.id);
    const items = orderIds.length
      ? await all(
          `SELECT * FROM order_items WHERE order_id IN (${orderIds.map(() => "?").join(",")}) ORDER BY id DESC`,
          orderIds
        )
      : [];

    const timelineEvents = orderIds.length
      ? await all(
          `SELECT * FROM order_timeline_events WHERE order_id IN (${orderIds.map(() => "?").join(",")}) ORDER BY id DESC`,
          orderIds
        )
      : [];

    const itemsByOrderId = items.reduce((acc, item) => {
      if (!acc[item.order_id]) acc[item.order_id] = [];
      acc[item.order_id].push(item);
      return acc;
    }, {});

    const timelineByOrderId = timelineEvents.reduce((acc, event) => {
      if (!acc[event.order_id]) acc[event.order_id] = [];
      acc[event.order_id].push(event);
      return acc;
    }, {});

    const data = orders.map((o) => ({ ...o, items: itemsByOrderId[o.id] || [], timeline: timelineByOrderId[o.id] || [] }));
    res.json({ data });
  } catch {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

app.patch("/api/admin/orders/:id/notes", requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const note = safeText(req.body?.note, MAX_INPUT_LENGTH.internalNotes);

    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: "Invalid order id" });
    const existing = await get("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!existing) return res.status(404).json({ error: "Order not found" });

    const mergedNotes = [existing.internal_notes, note].filter(Boolean).join("\n\n");
    await run(`UPDATE orders SET internal_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [mergedNotes, orderId]);
    await addOrderTimelineEvent(orderId, "internal_note", note || "Internal note updated", req.admin?.role || "admin");

    const updated = await get("SELECT * FROM orders WHERE id = ?", [orderId]);
    res.json({ data: updated });
  } catch {
    res.status(500).json({ error: "Failed to update order notes" });
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
    await addOrderTimelineEvent(orderId, "status_changed", `Status changed from ${existing.status} to ${status}`, req.admin?.role || "admin", {
      previousStatus: existing.status,
      nextStatus: status,
    });
    await writeAuditLog(req, "order.status", "order", orderId, { previousStatus: existing.status, nextStatus: status });
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

app.post("/api/assistant/recommend", async (req, res) => {
  try {
    const query = safeText(req.body?.query, 400);
    const rows = await all("SELECT * FROM products ORDER BY id DESC");
    const heuristic = buildDeterministicAssistantReply(query, rows);
    res.json({ data: heuristic });
  } catch {
    res.status(500).json({ error: "Assistant failed" });
  }
});

app.post("/api/analytics/event", async (req, res) => {
  try {
    const eventType = safeText(req.body?.eventType, 60);
    if (!eventType) return res.status(400).json({ error: "eventType is required" });
    await run(
      `INSERT INTO analytics_events (event_type, product_id, user_id, session_id, location, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eventType, Number(req.body?.productId) || null, req.user?.id || null, safeText(req.body?.sessionId, 120), safeText(req.body?.location, 120), JSON.stringify(req.body?.payload || {})]
    );
    res.status(201).json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to save analytics event" });
  }
});

app.get("/api/cart/restore/:token", async (req, res) => {
  try {
    const token = safeText(req.params.token, 120);
    const snapshot = await get("SELECT payload, updated_at FROM cart_snapshots WHERE restore_token = ?", [token]);
    if (!snapshot) return res.status(404).json({ error: "Restore token not found" });
    let cart = [];
    try { cart = JSON.parse(snapshot.payload || "[]"); } catch { cart = []; }
    res.json({ data: { cart, updated_at: snapshot.updated_at } });
  } catch {
    res.status(500).json({ error: "Restore failed" });
  }
});

app.post("/api/jobs/abandoned-carts/run", async (req, res) => {
  const secret = String(process.env.ABANDONED_CART_JOB_SECRET || "").trim();
  const supplied = safeText(req.headers["x-job-secret"] || req.query?.key || req.body?.key, 300);
  if (!secret || supplied !== secret) return res.status(401).json({ error: "Unauthorized job trigger" });

  try {
    const minutes = Number(process.env.ABANDONED_CART_MINUTES || 60);
    const snapshots = await all(
      `SELECT * FROM cart_snapshots
       WHERE datetime(updated_at) <= datetime('now', ?)
       AND (abandoned_notified_at IS NULL)
       ORDER BY updated_at ASC LIMIT 100`,
      [`-${minutes} minutes`]
    );

    const sent = [];
    for (const s of snapshots) {
      if (!s.customer_email && !s.customer_phone) continue;
      const token = s.restore_token || makeRestoreToken();
      await run(`UPDATE cart_snapshots SET restore_token = COALESCE(restore_token, ?), abandoned_notified_at = CURRENT_TIMESTAMP WHERE id = ?`, [token, s.id]);
      const restoreUrl = `${BASE_URL}/?restore=${token}`;
      const channel = s.customer_email ? "email" : "whatsapp";
      const recipient = s.customer_email || s.customer_phone;
      await run(`INSERT INTO cart_recovery_logs (cart_snapshot_id, channel, recipient, status, payload) VALUES (?, ?, ?, 'queued', ?)`, [s.id, channel, recipient, JSON.stringify({ restoreUrl })]);
      sent.push({ snapshotId: s.id, channel, recipient, restoreUrl });
    }

    res.json({ ok: true, data: { scanned: snapshots.length, queued: sent.length, reminders: sent } });
  } catch {
    res.status(500).json({ error: "Abandoned cart job failed" });
  }
});

app.get("/api/admin/audit-logs", requireAdmin, requireAdminRole("manager"), async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?", [limit]);
    res.json({ data: rows });
  } catch {
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
});

app.get("/api/admin/promos", requireAdmin, requireAdminRole("manager"), async (_, res) => {
  try {
    const rows = await all("SELECT * FROM promo_rules ORDER BY id DESC");
    res.json({ data: rows });
  } catch {
    res.status(500).json({ error: "Failed to load promo rules" });
  }
});

app.post("/api/admin/promos", requireAdmin, requireAdminRole("manager"), async (req, res) => {
  try {
    const payload = {
      name: safeText(req.body?.name, 120),
      rule_type: safeText(req.body?.rule_type, 20) || "discount",
      category: normalizeCategory(req.body?.category),
      min_cart_amount: Number(req.body?.min_cart_amount) || 0,
      discount_type: safeText(req.body?.discount_type, 20) || "fixed",
      discount_value: Number(req.body?.discount_value) || 0,
      bogo_product_id: Number(req.body?.bogo_product_id) || null,
      bogo_buy_qty: Number(req.body?.bogo_buy_qty) || 1,
      bogo_get_qty: Number(req.body?.bogo_get_qty) || 1,
      starts_at: safeText(req.body?.starts_at, 40) || null,
      ends_at: safeText(req.body?.ends_at, 40) || null,
      is_active: req.body?.is_active === undefined ? 1 : (req.body?.is_active ? 1 : 0),
    };

    const created = await run(
      `INSERT INTO promo_rules (name, rule_type, category, min_cart_amount, discount_type, discount_value, bogo_product_id, bogo_buy_qty, bogo_get_qty, starts_at, ends_at, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [payload.name, payload.rule_type, payload.category || null, payload.min_cart_amount, payload.discount_type, payload.discount_value, payload.bogo_product_id, payload.bogo_buy_qty, payload.bogo_get_qty, payload.starts_at, payload.ends_at, payload.is_active]
    );
    await writeAuditLog(req, "promo.create", "promo_rule", created.id, payload);
    const row = await get("SELECT * FROM promo_rules WHERE id = ?", [created.id]);
    res.status(201).json({ data: row });
  } catch {
    res.status(500).json({ error: "Failed to create promo rule" });
  }
});

app.patch("/api/admin/promos/:id/toggle", requireAdmin, requireAdminRole("manager"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const next = req.body?.is_active ? 1 : 0;
    await run(`UPDATE promo_rules SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [next, id]);
    await writeAuditLog(req, "promo.toggle", "promo_rule", id, { is_active: next });
    const row = await get("SELECT * FROM promo_rules WHERE id = ?", [id]);
    res.json({ data: row });
  } catch {
    res.status(500).json({ error: "Failed to toggle promo rule" });
  }
});

app.get("/api/admin/analytics/advanced", requireAdmin, requireAdminRole("manager"), async (_, res) => {
  try {
    const [views, carts, checkouts, ordersCount, topProducts, repeatBuyers, locationBreakdown] = await Promise.all([
      get("SELECT COUNT(*) AS total FROM analytics_events WHERE event_type = 'view_product'"),
      get("SELECT COUNT(*) AS total FROM analytics_events WHERE event_type = 'add_to_cart'"),
      get("SELECT COUNT(*) AS total FROM analytics_events WHERE event_type = 'checkout_start'"),
      get("SELECT COUNT(*) AS total FROM orders"),
      all(`SELECT oi.product_id, oi.product_name, COUNT(*) AS order_lines, SUM(oi.quantity) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id GROUP BY oi.product_id, oi.product_name ORDER BY qty DESC LIMIT 10`),
      all(`SELECT customer_email, COUNT(*) AS orders_count FROM orders WHERE customer_email != '' GROUP BY customer_email HAVING COUNT(*) > 1 ORDER BY orders_count DESC LIMIT 20`),
      all(`SELECT COALESCE(delivery_zone_name, 'Unknown') AS location, COUNT(*) AS total FROM orders GROUP BY COALESCE(delivery_zone_name, 'Unknown') ORDER BY total DESC`),
    ]);

    res.json({
      data: {
        funnel: {
          views: Number(views?.total || 0),
          cartAdds: Number(carts?.total || 0),
          checkoutStarts: Number(checkouts?.total || 0),
          orders: Number(ordersCount?.total || 0),
        },
        topConvertingProducts: topProducts,
        repeatBuyers,
        locationBreakdown,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to build advanced analytics" });
  }
});

app.get("/api/me/addresses", requireUser, async (req, res) => {
  const rows = await all("SELECT * FROM user_addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC", [req.user.id]);
  res.json({ data: rows });
});

app.post("/api/me/addresses", requireUser, async (req, res) => {
  try {
    const isDefault = req.body?.is_default ? 1 : 0;
    if (isDefault) await run("UPDATE user_addresses SET is_default = 0 WHERE user_id = ?", [req.user.id]);
    const created = await run(
      `INSERT INTO user_addresses (user_id, label, recipient_name, phone, address_line, city, state, is_default, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [req.user.id, safeText(req.body?.label, 50), safeText(req.body?.recipient_name, 120), safeText(req.body?.phone, 30), safeText(req.body?.address_line, 300), safeText(req.body?.city, 80), safeText(req.body?.state, 80), isDefault]
    );
    const row = await get("SELECT * FROM user_addresses WHERE id = ?", [created.id]);
    res.status(201).json({ data: row });
  } catch {
    res.status(500).json({ error: "Failed to add address" });
  }
});

app.post("/api/orders/:id/reorder", requireUser, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = await get("SELECT * FROM orders WHERE id = ? AND user_id = ?", [orderId, req.user.id]);
    if (!order) return res.status(404).json({ error: "Order not found" });
    const items = await all("SELECT product_id, quantity FROM order_items WHERE order_id = ?", [orderId]);
    const cart = items.map((i) => ({ productId: i.product_id, quantity: i.quantity }));
    res.json({ data: { cart, sourceOrderId: orderId } });
  } catch {
    res.status(500).json({ error: "Failed to reorder" });
  }
});

app.get("/api/me/loyalty", requireUser, async (req, res) => {
  try {
    const [user, ledger] = await Promise.all([
      get("SELECT referral_code, total_loyalty_points FROM users WHERE id = ?", [req.user.id]),
      all("SELECT * FROM loyalty_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100", [req.user.id]),
    ]);
    res.json({ data: { totalPoints: Number(user?.total_loyalty_points || 0), referralCode: user?.referral_code || null, ledger } });
  } catch {
    res.status(500).json({ error: "Failed to fetch loyalty" });
  }
});

app.post("/api/returns", requireUser, async (req, res) => {
  try {
    const orderId = Number(req.body?.orderId);
    const order = await get("SELECT id, user_id FROM orders WHERE id = ?", [orderId]);
    if (!order || order.user_id !== req.user.id) return res.status(404).json({ error: "Order not found" });

    const created = await run(
      `INSERT INTO return_requests (order_id, user_id, reason, status, updated_at) VALUES (?, ?, ?, 'requested', CURRENT_TIMESTAMP)`,
      [orderId, req.user.id, safeText(req.body?.reason, 1000)]
    );
    await run(`INSERT INTO return_request_timeline (return_request_id, action, actor, note) VALUES (?, 'requested', 'customer', ?)`, [created.id, safeText(req.body?.reason, 1000)]);
    const row = await get("SELECT * FROM return_requests WHERE id = ?", [created.id]);
    res.status(201).json({ data: row });
  } catch {
    res.status(500).json({ error: "Failed to create return request" });
  }
});

app.get("/api/admin/returns", requireAdmin, requireAdminRole("inventory_staff"), async (_, res) => {
  try {
    const rows = await all("SELECT * FROM return_requests ORDER BY id DESC");
    res.json({ data: rows });
  } catch {
    res.status(500).json({ error: "Failed to fetch return requests" });
  }
});

app.patch("/api/admin/returns/:id", requireAdmin, requireAdminRole("manager"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const next = safeText(req.body?.status, 30);
    const allowed = new Set(["approved", "rejected", "received", "refunded"]);
    if (!allowed.has(next)) return res.status(400).json({ error: "Invalid status" });
    await run("UPDATE return_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [next, id]);
    await run(`INSERT INTO return_request_timeline (return_request_id, action, actor, note) VALUES (?, ?, ?, ?)`, [id, next, req.admin?.role || "admin", safeText(req.body?.note, 800)]);
    await writeAuditLog(req, "return.update", "return_request", id, { status: next });
    const row = await get("SELECT * FROM return_requests WHERE id = ?", [id]);
    res.json({ data: row });
  } catch {
    res.status(500).json({ error: "Failed to update return request" });
  }
});

app.get("/api/admin/orders/risk-queue", requireAdmin, requireAdminRole("inventory_staff"), async (req, res) => {
  try {
    const level = safeText(req.query.level, 20).toLowerCase();
    const rows = level
      ? await all("SELECT * FROM orders WHERE risk_level = ? ORDER BY id DESC", [level])
      : await all("SELECT * FROM orders WHERE manual_review_status = 'queued' ORDER BY id DESC");
    res.json({ data: rows });
  } catch {
    res.status(500).json({ error: "Failed to fetch risk queue" });
  }
});

app.patch("/api/admin/orders/:id/review", requireAdmin, requireAdminRole("manager"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = safeText(req.body?.manual_review_status, 30);
    const allowed = new Set(["queued", "approved", "rejected", "clear"]);
    if (!allowed.has(status)) return res.status(400).json({ error: "Invalid review status" });
    await run("UPDATE orders SET manual_review_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [status, id]);
    await writeAuditLog(req, "order.review", "order", id, { manual_review_status: status });
    const row = await get("SELECT * FROM orders WHERE id = ?", [id]);
    res.json({ data: row });
  } catch {
    res.status(500).json({ error: "Failed to update review status" });
  }
});

app.get("/api/inventory/locations", async (_, res) => {
  try {
    const rows = await all("SELECT * FROM inventory_locations WHERE is_active = 1 ORDER BY id ASC");
    res.json({ data: rows });
  } catch {
    res.status(500).json({ error: "Failed to fetch locations" });
  }
});

app.get("/api/admin/inventory/:productId", requireAdmin, requireAdminRole("inventory_staff"), async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const rows = await all(
      `SELECT pi.*, il.code, il.name, il.eta_days
       FROM product_inventory pi
       JOIN inventory_locations il ON il.id = pi.location_id
       WHERE pi.product_id = ?
       ORDER BY il.id ASC`,
      [productId]
    );
    res.json({ data: rows });
  } catch {
    res.status(500).json({ error: "Failed to fetch product inventory" });
  }
});

app.post("/api/admin/inventory/:productId", requireAdmin, requireAdminRole("inventory_staff"), async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const locationCode = safeText(req.body?.locationCode, 60).toLowerCase();
    const quantity = Math.max(0, Number(req.body?.quantity) || 0);

    const location = await get("SELECT id FROM inventory_locations WHERE code = ?", [locationCode]);
    if (!location) return res.status(400).json({ error: "Invalid locationCode" });

    await run(
      `INSERT INTO product_inventory (product_id, location_id, quantity, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = excluded.quantity, updated_at = CURRENT_TIMESTAMP`,
      [productId, location.id, quantity]
    );

    const total = await get("SELECT COALESCE(SUM(quantity),0) AS total FROM product_inventory WHERE product_id = ?", [productId]);
    await run("UPDATE products SET stock_quantity = ?, in_stock = CASE WHEN ? > 0 THEN 1 ELSE 0 END WHERE id = ?", [Number(total?.total || 0), Number(total?.total || 0), productId]);
    await writeAuditLog(req, "inventory.set", "product", productId, { locationCode, quantity });

    const rows = await all(
      `SELECT pi.*, il.code, il.name, il.eta_days
       FROM product_inventory pi
       JOIN inventory_locations il ON il.id = pi.location_id
       WHERE pi.product_id = ?
       ORDER BY il.id ASC`,
      [productId]
    );

    res.json({ data: rows });
  } catch {
    res.status(500).json({ error: "Failed to update product inventory" });
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
      "discount_amount",
      "coupon_code",
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
            discount_amount: money.discountAmount,
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

app.get("/track/:reference", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "track.html"));
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

initDb().then(async () => {
  await ensureAdvancedSchema({ run, all });

  const seedAdminEmail = normalizeEmail(process.env.SEED_ADMIN_EMAIL || "");
  const seedAdminPassword = String(process.env.SEED_ADMIN_PASSWORD || "");
  if (seedAdminEmail && seedAdminPassword) {
    const existing = await get("SELECT id FROM admin_users WHERE email = ?", [seedAdminEmail]);
    if (!existing) {
      const hash = await bcrypt.hash(seedAdminPassword, 12);
      await run(`INSERT INTO admin_users (name, email, password_hash, role, is_active, updated_at) VALUES (?, ?, ?, 'super_admin', 1, CURRENT_TIMESTAMP)`, ["Seed Admin", seedAdminEmail, hash]);
      console.log(`[seed] created admin user ${seedAdminEmail}`);
    }
  }

  app.listen(PORT, () => {
    console.log(`Vicbest Store running on http://localhost:${PORT}`);
    console.log(`SQLite DB: ${dbPath}`);
    getStartupWarnings().forEach((warning) => console.warn(`[startup-check] ${warning}`));
  });
}).catch((err) => {
  console.error("Failed to initialize database", err);
  process.exit(1);
});