require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const path = require("path");
const { initDb, all, get, run } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const VALID_CATEGORIES = new Set(["car", "grocery"]);
const ORDER_STATUSES = new Set(["pending_payment", "paid", "processing", "delivered", "cancelled"]);

app.use("/api/paystack/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function formatProducts(rows) {
  return rows.map((p) => ({
    ...p,
    metadata: p.metadata ? JSON.parse(p.metadata) : {},
  }));
}

function genRef() {
  return `VICBEST-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function adminSecret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || "vicbest-admin-secret";
}

function signAdminToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", adminSecret()).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [encoded, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", adminSecret()).update(encoded).digest("base64url");
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = verifyAdminToken(token);
  if (!payload) return res.status(401).json({ error: "Unauthorized" });
  req.admin = payload;
  next();
}

function toProductPayload(body = {}) {
  const name = String(body.name || "").trim();
  const category = String(body.category || "").trim();
  const price = Number(body.price);
  const description = String(body.description || "").trim();
  const image_url = String(body.image_url || "").trim();
  const in_stock = body.in_stock ? 1 : 0;

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
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) errors.push("metadata must be an object");

  return {
    errors,
    data: { name, category, price, description, image_url, metadata: JSON.stringify(metadata), in_stock },
  };
}

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.post("/api/admin/login", (req, res) => {
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
    const category = req.query.category;
    const rows = category
      ? await all("SELECT * FROM products WHERE category = ? ORDER BY id", [category])
      : await all("SELECT * FROM products ORDER BY id");
    res.json({ data: formatProducts(rows) });
  } catch {
    res.status(500).json({ error: "Failed to fetch products" });
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
      `INSERT INTO products (name, category, price, description, image_url, metadata, in_stock)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.name, data.category, data.price, data.description, data.image_url, data.metadata, data.in_stock]
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
       SET name = ?, category = ?, price = ?, description = ?, image_url = ?, metadata = ?, in_stock = ?
       WHERE id = ?`,
      [data.name, data.category, data.price, data.description, data.image_url, data.metadata, data.in_stock, productId]
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
    const { sessionId, cart } = req.body;
    if (!sessionId || !Array.isArray(cart)) {
      return res.status(400).json({ error: "sessionId and cart[] are required" });
    }
    const payload = JSON.stringify(cart);
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

app.post("/api/checkout/initialize", async (req, res) => {
  try {
    const { customer, items } = req.body;
    if (!customer?.name || !customer?.email || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "customer(name,email) and items are required" });
    }

    const productIds = [...new Set(items.map((i) => Number(i.productId)).filter((id) => Number.isInteger(id) && id > 0))];
    if (productIds.length === 0) return res.status(400).json({ error: "No valid cart items" });

    const products = await all(
      `SELECT id, name, price FROM products WHERE id IN (${productIds.map(() => "?").join(",")})`,
      productIds
    );
    const productMap = new Map(products.map((p) => [p.id, p]));

    let amount = 0;
    const normalizedItems = [];

    for (const item of items) {
      const product = productMap.get(Number(item.productId));
      const quantity = Number(item.quantity) || 1;
      if (!product || quantity <= 0) continue;
      const lineTotal = product.price * quantity;
      amount += lineTotal;
      normalizedItems.push({
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice: product.price,
        lineTotal,
      });
    }

    if (normalizedItems.length === 0) {
      return res.status(400).json({ error: "No valid cart items" });
    }

    const reference = genRef();
    const orderResult = await run(
      `INSERT INTO orders (customer_name, customer_email, customer_phone, shipping_address, notes, amount, status, payment_reference)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', ?)`,
      [
        customer.name,
        customer.email,
        customer.phone || "",
        customer.address || "",
        customer.notes || "",
        amount,
        reference,
      ]
    );

    for (const i of normalizedItems) {
      await run(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderResult.id, i.productId, i.productName, i.quantity, i.unitPrice, i.lineTotal]
      );
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
        email: customer.email,
        amount: amount * 100,
        reference,
        callback_url: `${BASE_URL}/checkout/success?reference=${reference}`,
        metadata: {
          orderId: orderResult.id,
          customerName: customer.name,
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
        amount,
        authorization_url: data.data.authorization_url,
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
    res.json({ data: { ...updated, items } });
  } catch {
    res.status(500).json({ error: "Failed to update order status" });
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

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Vicbest Store running on http://localhost:${PORT}`);
  });
});
