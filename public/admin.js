const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const ADMIN_TOKEN_KEY = 'vicbest_admin_token';
const ORDER_STATUSES = ['pending_payment', 'paid', 'processing', 'delivered', 'cancelled'];
const ORDER_FILTERS = ['', 'new', 'processing', 'delivered', 'cancelled'];
let token = localStorage.getItem(ADMIN_TOKEN_KEY) || '';
let products = [];
let activeOrderFilter = '';
let orderSearchTerm = '';
let orderSearchDebounce = null;

const $ = (id) => document.getElementById(id);
const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

function setAuthState(ok) {
  $('login-card').classList.toggle('hidden', ok);
  $('dashboard').classList.toggle('hidden', !ok);
  $('logout-btn').classList.toggle('hidden', !ok);
}

async function login(password) {
  const r = await fetch('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Login failed');
  token = d.token;
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

async function fetchMetrics() {
  const r = await fetch('/api/admin/dashboard/metrics', { headers: authHeaders() });
  const d = await r.json();
  if (!r.ok) return;
  const m = d.data;
  $('metrics-grid').innerHTML = [
    { k: 'Orders', v: m.totalOrders },
    { k: 'Paid', v: m.paidOrders },
    { k: 'Revenue', v: NGN.format(m.revenue) },
    { k: 'Products', v: m.products },
    { k: 'Users', v: m.users },
  ].map((x) => `<div class="bg-white border rounded-xl p-3"><p class="text-xs text-gray-500">${x.k}</p><p class="text-lg font-bold">${x.v}</p></div>`).join('');
}

async function fetchLowStock() {
  const r = await fetch('/api/admin/products/low-stock', { headers: authHeaders() });
  const d = await r.json();
  if (!r.ok) return;
  const rows = d.data || [];
  $('low-stock').textContent = rows.length
    ? `Alerts: ${rows.map((x) => `${x.name} (${x.stock_quantity}/${x.low_stock_threshold})`).join(', ')}`
    : 'No low-stock alerts';
}

function renderLowStockSummary(summary) {
  const products = summary?.products || [];
  $('low-stock-summary-meta').textContent = summary
    ? `Generated ${new Date(summary.generatedAt).toLocaleString()} • ${summary.lowStockCount} alert(s) out of ${summary.totalInStockProducts} in-stock products`
    : '';

  $('low-stock-summary-list').innerHTML = products.length
    ? `<ul class="space-y-2">${products.map((p) => `<li class="border rounded-lg p-3"><strong>${p.name}</strong> <span class="text-xs text-gray-500">(${p.category})</span><br><span class="text-red-700">Qty ${p.stock_quantity} <= Threshold ${p.low_stock_threshold}</span></li>`).join('')}</ul>`
    : '<p class="text-gray-500">No products currently below threshold.</p>';
}

async function fetchLowStockSummary() {
  const r = await fetch('/api/admin/products/low-stock-summary', { headers: authHeaders() });
  const d = await r.json();
  if (!r.ok) return;
  renderLowStockSummary(d.data);
}

async function runLowStockSummary() {
  const btn = $('run-low-stock-summary');
  btn.disabled = true;
  btn.textContent = 'Running...';
  try {
    const r = await fetch('/api/admin/products/low-stock-summary/run', { method: 'POST', headers: authHeaders() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed to run summary');
    renderLowStockSummary(d.data.summary);
    await fetchNotificationLogs();
  } catch (err) {
    $('low-stock-summary-meta').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run & Email Summary';
  }
}

async function fetchNotificationLogs() {
  const r = await fetch('/api/admin/notifications/logs?limit=60', { headers: authHeaders() });
  const d = await r.json();
  if (!r.ok) {
    $('notification-logs-tbody').innerHTML = '<tr><td colspan="7" class="py-3 text-red-600">Failed to load notification logs</td></tr>';
    return;
  }
  const rows = d.data || [];
  $('notification-logs-tbody').innerHTML = rows.length
    ? rows.map((log) => `<tr class="border-b"><td class="py-2 pr-2">${log.created_at || '-'}</td><td>${log.event_type || '-'}</td><td>${log.channel || '-'}</td><td>${log.recipient || '-'}</td><td><span class="px-2 py-1 rounded text-xs ${log.status === 'sent' ? 'bg-green-100 text-green-700' : log.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}">${log.status || '-'}</span></td><td>${log.payment_reference || (log.order_id ? `#${log.order_id}` : '-')}</td><td class="max-w-xs truncate" title="${(log.error_message || '').replaceAll('"', '&quot;')}">${log.error_message || '-'}</td></tr>`).join('')
    : '<tr><td colspan="7" class="py-3 text-gray-500">No notification logs yet.</td></tr>';
}

function fillForm(p) {
  $('product-id').value = p.id;
  $('product-name').value = p.name;
  $('product-category').value = p.category;
  $('product-price').value = p.price;
  $('product-stock-qty').value = p.stock_quantity ?? 0;
  $('product-low-threshold').value = p.low_stock_threshold ?? 5;
  $('product-image').value = p.image_url || '';
  $('product-description').value = p.description || '';
  $('product-metadata').value = JSON.stringify(p.metadata || {}, null, 2);
  $('product-stock').checked = Boolean(p.in_stock);
}

function resetForm() {
  ['product-id', 'product-name', 'product-price', 'product-image', 'product-description'].forEach((k) => $(k).value = '');
  $('product-category').value = 'car';
  $('product-stock-qty').value = '10';
  $('product-low-threshold').value = '5';
  $('product-metadata').value = '{}';
  $('product-stock').checked = true;
  $('product-form-msg').textContent = '';
}

async function fetchProducts() {
  const r = await fetch('/api/admin/products', { headers: authHeaders() });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Failed products');
  products = d.data || [];
  $('products-tbody').innerHTML = products.map((p) => `<tr class="border-b"><td>${p.id}</td><td>${p.name}</td><td>${p.category}</td><td>${NGN.format(p.price)}</td><td>${p.stock_quantity ?? '-'}</td><td>${p.low_stock_threshold ?? 5}</td><td>${p.in_stock ? 'In' : 'Out'}</td><td><button data-edit="${p.id}" class="text-blue-700">Edit</button> <button data-del="${p.id}" class="text-red-700">Delete</button></td></tr>`).join('');
  document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => fillForm(products.find((x) => x.id === Number(b.dataset.edit))));
  document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this product?')) return;
    const r = await fetch(`/api/admin/products/${b.dataset.del}`, { method: 'DELETE', headers: authHeaders() });
    if (r.ok) {
      await Promise.all([fetchProducts(), fetchMetrics(), fetchLowStock(), fetchLowStockSummary()]);
    }
  });
}

function statusChip(status) {
  const map = {
    pending_payment: 'bg-amber-100 text-amber-800',
    paid: 'bg-blue-100 text-blue-700',
    processing: 'bg-indigo-100 text-indigo-700',
    delivered: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700'
  };
  return `<span class="px-2 py-1 rounded-full text-xs font-semibold ${map[status] || 'bg-gray-100 text-gray-700'}">${status}</span>`;
}

function quickActions(o) {
  const actions = [];
  if (o.status !== 'processing') actions.push({ next: 'processing', label: 'Mark processing' });
  if (o.status !== 'delivered') actions.push({ next: 'delivered', label: 'Mark delivered' });
  if (o.status !== 'cancelled') actions.push({ next: 'cancelled', label: 'Cancel' });
  return actions.map((a) => `<button data-quick-status="${o.id}" data-next-status="${a.next}" class="px-2 py-1 rounded border text-xs hover:bg-gray-50">${a.label}</button>`).join('');
}

function orderCard(o) {
  const opts = ORDER_STATUSES.map((s) => `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s}</option>`).join('');
  const items = (o.items || []).map((i) => `<li>${i.quantity} × ${i.product_name}</li>`).join('');
  const hasSubtotal = o.subtotal_amount !== null && o.subtotal_amount !== undefined && o.subtotal_amount !== '';
  const hasDeliveryFee = o.delivery_fee !== null && o.delivery_fee !== undefined && o.delivery_fee !== '';
  const hasGrandTotal = o.grand_total !== null && o.grand_total !== undefined && o.grand_total !== '';
  const subtotal = hasSubtotal ? Number(o.subtotal_amount) : Number(o.amount || 0);
  const deliveryFee = hasDeliveryFee ? Number(o.delivery_fee) : 0;
  const grandTotal = hasGrandTotal ? Number(o.grand_total) : Number(o.amount || subtotal + deliveryFee);
  const location = o.delivery_zone_name || o.delivery_zone_code || '-';
  return `<div class="border rounded-xl p-4"><div class="flex flex-col sm:flex-row justify-between gap-3"><div><p class="font-bold">Order #${o.id} • ${o.payment_reference || 'N/A'}</p><p class="text-sm">${o.customer_name} • ${o.customer_email}</p><p class="text-xs text-gray-600">Location: ${location}</p><p class="text-xs text-gray-600">Subtotal: ${NGN.format(subtotal)} • Delivery: ${NGN.format(deliveryFee)}</p></div><div class="sm:text-right space-y-2"><p class="font-semibold">${NGN.format(grandTotal)}</p>${statusChip(o.status)}<div><select data-order-status="${o.id}" class="border rounded px-2 py-1 text-sm mt-1">${opts}</select></div></div></div><div class="mt-3 flex flex-wrap gap-2">${quickActions(o)}</div><ul class="text-sm mt-2 list-disc pl-5">${items || '<li>No items</li>'}</ul></div>`;
}

async function updateOrderStatus(orderId, status) {
  const r = await fetch(`/api/admin/orders/${orderId}/status`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ status }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Failed to update order');
}

function syncOrderFilterButtons() {
  document.querySelectorAll('.order-filter-btn').forEach((btn) => {
    const active = btn.dataset.filter === activeOrderFilter;
    btn.classList.toggle('bg-blue-900', active);
    btn.classList.toggle('text-white', active);
  });
}

async function fetchOrders() {
  const params = new URLSearchParams();
  if (activeOrderFilter) params.set('status', activeOrderFilter);
  if (orderSearchTerm.trim()) params.set('search', orderSearchTerm.trim());
  const query = params.toString();
  const r = await fetch(`/api/admin/orders${query ? `?${query}` : ''}`, { headers: authHeaders() });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Orders failed');
  $('orders-wrap').innerHTML = (d.data || []).map(orderCard).join('') || '<p class="text-gray-500">No orders found.</p>';
  document.querySelectorAll('[data-order-status]').forEach((s) => s.onchange = async () => {
    await updateOrderStatus(s.dataset.orderStatus, s.value);
    await Promise.all([fetchOrders(), fetchMetrics(), fetchNotificationLogs()]);
  });
  document.querySelectorAll('[data-quick-status]').forEach((btn) => btn.onclick = async () => {
    btn.disabled = true;
    try {
      await updateOrderStatus(btn.dataset.quickStatus, btn.dataset.nextStatus);
      await Promise.all([fetchOrders(), fetchMetrics(), fetchNotificationLogs()]);
    } catch (err) {
      alert(err.message);
    }
  });
}

async function bootstrap() {
  setAuthState(true);
  activeOrderFilter = ORDER_FILTERS.includes($('order-filter').value) ? $('order-filter').value : '';
  $('order-filter').value = activeOrderFilter;
  syncOrderFilterButtons();
  await Promise.all([fetchMetrics(), fetchLowStock(), fetchProducts(), fetchOrders(), fetchNotificationLogs(), fetchLowStockSummary()]);
  $('export-csv').onclick = (e) => {
    e.preventDefault();
    window.open(`/api/admin/orders/export.csv?token=${encodeURIComponent(token)}`, '_blank');
  };
  $('refresh-notifications').onclick = fetchNotificationLogs;
  $('run-low-stock-summary').onclick = runLowStockSummary;
}

$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await login($('admin-password').value);
    await bootstrap();
  } catch (err) {
    $('login-error').classList.remove('hidden');
    $('login-error').textContent = err.message;
  }
};

$('product-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const id = $('product-id').value;
    const payload = {
      name: $('product-name').value,
      category: $('product-category').value,
      price: Number($('product-price').value),
      stock_quantity: Number($('product-stock-qty').value),
      low_stock_threshold: Number($('product-low-threshold').value),
      image_url: $('product-image').value,
      description: $('product-description').value,
      metadata: $('product-metadata').value,
      in_stock: $('product-stock').checked,
    };
    const r = await fetch(id ? `/api/admin/products/${id}` : '/api/admin/products', {
      method: id ? 'PUT' : 'POST', headers: authHeaders(), body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Save failed');
    $('product-form-msg').textContent = 'Saved.';
    resetForm();
    await Promise.all([fetchProducts(), fetchLowStock(), fetchLowStockSummary(), fetchMetrics()]);
  } catch (err) {
    $('product-form-msg').textContent = err.message;
  }
};

$('reset-product').onclick = resetForm;
$('order-filter').onchange = async (e) => {
  activeOrderFilter = ORDER_FILTERS.includes(e.target.value) ? e.target.value : '';
  syncOrderFilterButtons();
  await fetchOrders();
};
$('order-search').oninput = () => {
  orderSearchTerm = $('order-search').value || '';
  clearTimeout(orderSearchDebounce);
  orderSearchDebounce = setTimeout(() => {
    fetchOrders().catch((err) => {
      $('orders-wrap').innerHTML = `<p class="text-red-600 text-sm">${err.message}</p>`;
    });
  }, 250);
};
document.querySelectorAll('.order-filter-btn').forEach((btn) => btn.onclick = async () => {
  activeOrderFilter = btn.dataset.filter || '';
  $('order-filter').value = activeOrderFilter;
  syncOrderFilterButtons();
  await fetchOrders();
});
$('logout-btn').onclick = () => {
  token = '';
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  setAuthState(false);
};

if (token) bootstrap(); else setAuthState(false);
