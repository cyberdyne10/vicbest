const nodemailer = require("nodemailer");
const { run } = require("./db");

const STATUS_LABELS = {
  pending_payment: "Pending Payment",
  paid: "Paid",
  processing: "Processing",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

function normalizeEmails(value = "") {
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function formatNgn(amount) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);
}

function orderTotals(order = {}) {
  const subtotal =
    order.subtotal_amount !== null && order.subtotal_amount !== undefined
      ? Number(order.subtotal_amount)
      : Number(order.amount || 0);
  const deliveryFee =
    order.delivery_fee !== null && order.delivery_fee !== undefined
      ? Number(order.delivery_fee)
      : 0;
  const grandTotal =
    order.grand_total !== null && order.grand_total !== undefined
      ? Number(order.grand_total)
      : Number(order.amount || subtotal + deliveryFee);

  return { subtotal, deliveryFee, grandTotal };
}

function transportConfig() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const from = String(process.env.SMTP_FROM || user || "").trim();

  return { host, port, user, pass, secure, from };
}

function hasSmtpConfig() {
  const cfg = transportConfig();
  return Boolean(cfg.host && cfg.port && cfg.user && cfg.pass && cfg.from);
}

function buildTransport() {
  const cfg = transportConfig();
  return {
    from: cfg.from,
    transporter: nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    }),
  };
}

function getStoreWhatsappNumber() {
  return String(process.env.STORE_WHATSAPP_NUMBER || "2348091747685").replace(/\D/g, "");
}

function customerFallbackPayload(order, items = []) {
  const totals = orderTotals(order);
  const lines = [
    `Order Confirmation: ${order.payment_reference || `#${order.id}`}`,
    `Hello ${order.customer_name || "Customer"}, your order has been received by Vicbest Store.`, 
    "",
    ...items.map((item, index) => `${index + 1}. ${item.product_name} x ${item.quantity} - ${formatNgn(item.line_total)}`),
    "",
    `Subtotal: ${formatNgn(totals.subtotal)}`,
    `Delivery: ${formatNgn(totals.deliveryFee)}`,
    `Grand Total: ${formatNgn(totals.grandTotal)}`,
    `Status: ${STATUS_LABELS[order.status] || order.status}`,
  ];

  const text = lines.join("\n");
  return {
    text,
    whatsappUrl: `https://wa.me/${getStoreWhatsappNumber()}?text=${encodeURIComponent(text)}`,
  };
}

async function logNotification({ orderId, eventType, channel, recipient, status, error = "", payload = null }) {
  try {
    await run(
      `INSERT INTO notification_logs (order_id, event_type, channel, recipient, status, error_message, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId || null,
        eventType || "unknown",
        channel || "unknown",
        recipient || "",
        status || "unknown",
        error ? String(error).slice(0, 2000) : null,
        payload ? JSON.stringify(payload) : null,
      ]
    );
  } catch (err) {
    console.error("notification_logs insert failed", err.message);
  }
}

function orderItemsHtml(items = []) {
  const lines = items
    .map((item) => `<li>${item.quantity} × ${item.product_name} — ${formatNgn(item.line_total)}</li>`)
    .join("");
  return lines || "<li>No items captured</li>";
}

async function sendEmail({ to, subject, text, html }) {
  const { transporter, from } = buildTransport();
  return transporter.sendMail({ from, to, subject, text, html });
}

async function notifyCustomerOrderCreated(order, items = []) {
  const eventType = "order_created_customer";
  const recipient = order.customer_email;
  const totals = orderTotals(order);

  if (!hasSmtpConfig()) {
    const fallback = customerFallbackPayload(order, items);
    await logNotification({
      orderId: order.id,
      eventType,
      channel: "whatsapp_link",
      recipient,
      status: "fallback",
      payload: fallback,
      error: "SMTP not configured",
    });
    return { delivered: false, fallback };
  }

  const subject = `Order received: ${order.payment_reference || `#${order.id}`}`;
  const text = [
    `Hi ${order.customer_name || "Customer"},`,
    "",
    "Your order has been received by Vicbest Store.",
    `Reference: ${order.payment_reference || order.id}`,
    `Status: ${STATUS_LABELS[order.status] || order.status}`,
    `Subtotal: ${formatNgn(totals.subtotal)}`,
    `Delivery: ${formatNgn(totals.deliveryFee)}`,
    `Grand Total: ${formatNgn(totals.grandTotal)}`,
    "",
    "Items:",
    ...items.map((item) => `- ${item.quantity} x ${item.product_name} (${formatNgn(item.line_total)})`),
  ].join("\n");

  const html = `
    <h3>Vicbest Store Order Confirmation</h3>
    <p>Hi ${order.customer_name || "Customer"}, your order has been received.</p>
    <p><strong>Reference:</strong> ${order.payment_reference || order.id}</p>
    <p><strong>Status:</strong> ${STATUS_LABELS[order.status] || order.status}</p>
    <p><strong>Subtotal:</strong> ${formatNgn(totals.subtotal)}<br>
    <strong>Delivery:</strong> ${formatNgn(totals.deliveryFee)}<br>
    <strong>Grand Total:</strong> ${formatNgn(totals.grandTotal)}</p>
    <p><strong>Items:</strong></p>
    <ul>${orderItemsHtml(items)}</ul>
  `;

  try {
    await sendEmail({ to: recipient, subject, text, html });
    await logNotification({
      orderId: order.id,
      eventType,
      channel: "email",
      recipient,
      status: "sent",
    });
    return { delivered: true, fallback: null };
  } catch (err) {
    const fallback = customerFallbackPayload(order, items);
    await logNotification({
      orderId: order.id,
      eventType,
      channel: "email",
      recipient,
      status: "failed",
      error: err.message,
      payload: fallback,
    });
    return { delivered: false, fallback };
  }
}

async function notifyAdminOrderCreated(order, items = []) {
  const recipients = normalizeEmails(process.env.ADMIN_NOTIFICATION_EMAILS || "");
  const eventType = "order_created_admin";
  const totals = orderTotals(order);

  if (!recipients.length) {
    await logNotification({
      orderId: order.id,
      eventType,
      channel: "email",
      recipient: "",
      status: "skipped",
      error: "ADMIN_NOTIFICATION_EMAILS not configured",
    });
    return;
  }

  if (!hasSmtpConfig()) {
    for (const recipient of recipients) {
      await logNotification({
        orderId: order.id,
        eventType,
        channel: "email",
        recipient,
        status: "skipped",
        error: "SMTP not configured",
      });
    }
    return;
  }

  const subject = `New order alert: ${order.payment_reference || `#${order.id}`}`;
  const text = [
    "A new order was created.",
    `Order ID: ${order.id}`,
    `Reference: ${order.payment_reference || "N/A"}`,
    `Customer: ${order.customer_name} (${order.customer_email})`,
    `Status: ${STATUS_LABELS[order.status] || order.status}`,
    `Grand Total: ${formatNgn(totals.grandTotal)}`,
    "",
    "Items:",
    ...items.map((item) => `- ${item.quantity} x ${item.product_name} (${formatNgn(item.line_total)})`),
  ].join("\n");

  const html = `
    <h3>New Order Alert</h3>
    <p><strong>Order ID:</strong> ${order.id}<br>
    <strong>Reference:</strong> ${order.payment_reference || "N/A"}<br>
    <strong>Customer:</strong> ${order.customer_name} (${order.customer_email})<br>
    <strong>Status:</strong> ${STATUS_LABELS[order.status] || order.status}<br>
    <strong>Grand Total:</strong> ${formatNgn(totals.grandTotal)}</p>
    <ul>${orderItemsHtml(items)}</ul>
  `;

  for (const recipient of recipients) {
    try {
      await sendEmail({ to: recipient, subject, text, html });
      await logNotification({ orderId: order.id, eventType, channel: "email", recipient, status: "sent" });
    } catch (err) {
      await logNotification({
        orderId: order.id,
        eventType,
        channel: "email",
        recipient,
        status: "failed",
        error: err.message,
      });
    }
  }
}

async function notifyNewOrder(order, items = []) {
  const [customerResult] = await Promise.all([
    notifyCustomerOrderCreated(order, items),
    notifyAdminOrderCreated(order, items),
  ]);
  return customerResult;
}

async function notifyOrderStatusChanged(order, previousStatus, nextStatus) {
  const watched = new Set(["processing", "delivered", "cancelled"]);
  if (!watched.has(nextStatus) || previousStatus === nextStatus) return;

  const eventType = "order_status_changed";
  const recipient = order.customer_email;

  if (!hasSmtpConfig()) {
    await logNotification({
      orderId: order.id,
      eventType,
      channel: "email",
      recipient,
      status: "skipped",
      error: "SMTP not configured",
      payload: { previousStatus, nextStatus },
    });
    return;
  }

  const subject = `Order update: ${order.payment_reference || `#${order.id}`} is now ${STATUS_LABELS[nextStatus] || nextStatus}`;
  const text = [
    `Hi ${order.customer_name || "Customer"},`,
    "",
    `Your order ${order.payment_reference || `#${order.id}`} status changed from ${STATUS_LABELS[previousStatus] || previousStatus} to ${STATUS_LABELS[nextStatus] || nextStatus}.`,
  ].join("\n");

  const html = `<p>Hi ${order.customer_name || "Customer"},</p><p>Your order <strong>${order.payment_reference || `#${order.id}`}</strong> status changed from <strong>${STATUS_LABELS[previousStatus] || previousStatus}</strong> to <strong>${STATUS_LABELS[nextStatus] || nextStatus}</strong>.</p>`;

  try {
    await sendEmail({ to: recipient, subject, text, html });
    await logNotification({
      orderId: order.id,
      eventType,
      channel: "email",
      recipient,
      status: "sent",
      payload: { previousStatus, nextStatus },
    });
  } catch (err) {
    await logNotification({
      orderId: order.id,
      eventType,
      channel: "email",
      recipient,
      status: "failed",
      error: err.message,
      payload: { previousStatus, nextStatus },
    });
  }
}

module.exports = {
  notifyNewOrder,
  notifyOrderStatusChanged,
};
