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

function normalizeCategory(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'cars') return 'car';
  if (raw === 'groceries') return 'grocery';
  return raw;
}

function setLegacyCategoryOption(category) {
  const select = $('product-category');
  const legacyOption = $('product-category-legacy');
  const normalized = normalizeCategory(category);
  const standard = ['car', 'grocery'];
  if (!normalized || standard.includes(normalized)) {
    legacyOption.value = '';
    legacyOption.textContent = '';
    legacyOption.classList.add('hidden');
    return;
  }
  legacyOption.value = normalized;
  legacyOption.textContent = `Legacy: ${normalized}`;
  legacyOption.classList.remove('hidden');
}


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
  setLegacyCategoryOption(p.category);
  $('product-category').value = normalizeCategory(p.category) || 'car';
  $('product-price').value = p.price;
  $('product-stock-qty').value = p.stock_quantity ?? 0;
  $('product-low-threshold').value = p.low_stock_threshold ?? 5;
  $('product-image').value = p.image_url || '';
  $('product-image-file').value = '';
  $('product-description').value = p.description || '';
  $('product-metadata').value = JSON.stringify(p.metadata || {}, null, 2);
  $('product-stock').checked = Boolean(p.in_stock);
}

function resetForm() {
  ['product-id', 'product-name', 'product-price', 'product-image', 'product-description'].forEach((k) => $(k).value = '');
  $('product-category').value = 'car';
  $('product-image-file').value = '';
  setLegacyCategoryOption('');
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
  const timeline = (o.timeline || []).slice(0, 5).map((t) => `<li>${t.created_at || ''} • ${t.message || t.event_type}</li>`).join('');
  const hasSubtotal = o.subtotal_amount !== null && o.subtotal_amount !== undefined && o.subtotal_amount !== '';
  const hasDeliveryFee = o.delivery_fee !== null && o.delivery_fee !== undefined && o.delivery_fee !== '';
  const hasDiscount = o.discount_amount !== null && o.discount_amount !== undefined && o.discount_amount !== '';
  const hasGrandTotal = o.grand_total !== null && o.grand_total !== undefined && o.grand_total !== '';
  const subtotal = hasSubtotal ? Number(o.subtotal_amount) : Number(o.amount || 0);
  const deliveryFee = hasDeliveryFee ? Number(o.delivery_fee) : 0;
  const discountAmount = hasDiscount ? Number(o.discount_amount) : 0;
  const grandTotal = hasGrandTotal ? Number(o.grand_total) : Number(o.amount || subtotal + deliveryFee - discountAmount);
  const location = o.delivery_zone_name || o.delivery_zone_code || '-';
  return `<div class="border rounded-xl p-4"><div class="flex flex-col sm:flex-row justify-between gap-3"><div><p class="font-bold">Order #${o.id} • ${o.payment_reference || 'N/A'}</p><p class="text-sm">${o.customer_name} • ${o.customer_email}</p><p class="text-xs text-gray-600">Location: ${location}</p><p class="text-xs text-gray-600">Subtotal: ${NGN.format(subtotal)} • Discount: ${NGN.format(discountAmount)} • Delivery: ${NGN.format(deliveryFee)}</p><p class="text-xs text-gray-600">Coupon: ${o.coupon_code || '-'}</p></div><div class="sm:text-right space-y-2"><p class="font-semibold">${NGN.format(grandTotal)}</p>${statusChip(o.status)}<div><select data-order-status="${o.id}" class="border rounded px-2 py-1 text-sm mt-1">${opts}</select></div></div></div><div class="mt-3 flex flex-wrap gap-2">${quickActions(o)}</div><ul class="text-sm mt-2 list-disc pl-5">${items || '<li>No items</li>'}</ul><div class="mt-3"><textarea data-note-input="${o.id}" class="w-full border rounded p-2 text-xs" rows="2" placeholder="Internal note for team"></textarea><button data-save-note="${o.id}" class="mt-1 px-2 py-1 text-xs border rounded">Save note</button><p class="text-xs text-gray-600 mt-1 whitespace-pre-wrap">${o.internal_notes || ''}</p></div><div class="mt-2 text-xs text-gray-600"><p class="font-semibold">Timeline</p><ul class="list-disc pl-5">${timeline || '<li>No events yet</li>'}</ul></div></div>`;
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
  document.querySelectorAll('[data-save-note]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.saveNote;
    const note = document.querySelector(`[data-note-input="${id}"]`)?.value?.trim() || '';
    if (!note) return;
    const r = await fetch(`/api/admin/orders/${id}/notes`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ note }) });
    const d = await r.json();
    if (!r.ok) return alert(d.error || 'Failed to save note');
    await fetchOrders();
  });
}

async function runCsvUpload() {
  const csv = $('csv-input')?.value || '';
  if (!csv.trim()) return;
  $('csv-upload-msg').textContent = 'Uploading...';
  const r = await fetch('/api/admin/products/bulk-upload', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ csv }) });
  const d = await r.json();
  if (!r.ok) {
    $('csv-upload-msg').textContent = d.error || 'Upload failed';
    return;
  }
  $('csv-upload-msg').textContent = `Done: ${d.data.successes} success, ${d.data.failures} failed`;
  $('csv-upload-report').innerHTML = (d.data.report || []).map((x) => `<div class="${x.success ? 'text-green-700' : 'text-red-700'}">Row ${x.row}: ${x.success ? `${x.action} ${x.name}` : x.error}</div>`).join('');
  await Promise.all([fetchProducts(), fetchMetrics(), fetchLowStock(), fetchLowStockSummary()]);
}

async function fetchCoupons() {
  const r = await fetch('/api/admin/coupons', { headers: authHeaders() });
  const d = await r.json();
  if (!r.ok) return;
  $('coupons-wrap').innerHTML = (d.data || []).map((c) => `<div class="border rounded p-2"><p class="font-semibold">${c.code}</p><p>${c.discount_type === 'percent' ? `${c.discount_value}%` : NGN.format(c.discount_value)} off • used ${c.used_count}${c.usage_limit ? `/${c.usage_limit}` : ''}</p></div>`).join('') || '<p class="text-gray-500">No coupons yet.</p>';
}

async function saveCoupon(e) {
  e.preventDefault();
  const payload = {
    code: $('coupon-code').value.trim(),
    discount_type: $('coupon-type').value,
    discount_value: Number($('coupon-value').value),
    min_order_amount: $('coupon-min').value ? Number($('coupon-min').value) : null,
    usage_limit: $('coupon-limit').value ? Number($('coupon-limit').value) : null,
    is_active: true,
  };
  const r = await fetch('/api/admin/coupons', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  const d = await r.json();
  if (!r.ok) return alert(d.error || 'Coupon save failed');
  $('coupon-form').reset();
  await fetchCoupons();
}

async function bootstrap() {
  setAuthState(true);
  activeOrderFilter = ORDER_FILTERS.includes($('order-filter').value) ? $('order-filter').value : '';
  $('order-filter').value = activeOrderFilter;
  syncOrderFilterButtons();
  await Promise.all([fetchMetrics(), fetchLowStock(), fetchProducts(), fetchOrders(), fetchNotificationLogs(), fetchLowStockSummary(), fetchCoupons()]);
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

async function uploadImageIfNeeded() {
  const file = $('product-image-file').files?.[0];
  if (!file) return null;

  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) throw new Error('Upload only JPG, PNG, WEBP, or GIF images.');
  if (file.size > 4 * 1024 * 1024) throw new Error('Image must be 4MB or less.');

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });

  const uploadRes = await fetch('/api/admin/uploads/product-image', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ fileName: file.name, dataUrl }),
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(uploadData.error || 'Image upload failed');
  return uploadData?.data?.image_url || null;
}

function validateProductForm(payload) {
  if (!payload.name) return 'Product name is required.';
  if (!payload.category) return 'Please choose Cars or Groceries.';
  if (!Number.isInteger(payload.price) || payload.price < 0) return 'Price must be a valid number.';
  if (!Number.isInteger(payload.stock_quantity) || payload.stock_quantity < 0) return 'Stock quantity must be 0 or higher.';
  if (!Number.isInteger(payload.low_stock_threshold) || payload.low_stock_threshold < 0) return 'Low-stock alert must be 0 or higher.';

  if (payload.image_url && !payload.image_url.startsWith('/uploads/') && !/^https?:\/\//i.test(payload.image_url)) {
    return 'Image URL must start with https://, http://, or /uploads/.';
  }

  if (payload.metadata) {
    try {
      const parsed = JSON.parse(payload.metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'Metadata must be a JSON object (or {}).';
    } catch {
      return 'Metadata must be valid JSON. Use {} if unsure.';
    }
  }

  return null;
}

$('product-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    $('product-form-msg').textContent = 'Saving...';
    const id = $('product-id').value;
    const uploadedImageUrl = await uploadImageIfNeeded();
    if (uploadedImageUrl) $('product-image').value = uploadedImageUrl;

    const payload = {
      name: $('product-name').value.trim(),
      category: normalizeCategory($('product-category').value),
      price: Number($('product-price').value),
      stock_quantity: Number($('product-stock-qty').value),
      low_stock_threshold: Number($('product-low-threshold').value),
      image_url: $('product-image').value.trim(),
      description: $('product-description').value.trim(),
      metadata: $('product-metadata').value.trim() || '{}',
      in_stock: $('product-stock').checked,
    };

    const validationError = validateProductForm(payload);
    if (validationError) throw new Error(validationError);

    const r = await fetch(id ? `/api/admin/products/${id}` : '/api/admin/products', {
      method: id ? 'PUT' : 'POST', headers: authHeaders(), body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Save failed');
    $('product-form-msg').textContent = 'Saved. Product is live.';
    resetForm();
    await Promise.all([fetchProducts(), fetchLowStock(), fetchLowStockSummary(), fetchMetrics()]);
  } catch (err) {
    $('product-form-msg').textContent = err.message;
  }
};

$('reset-product').onclick = resetForm;
$('product-category').onchange = () => {
  if (['car', 'grocery'].includes(normalizeCategory($('product-category').value))) {
    setLegacyCategoryOption('');
  }
};
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
$('run-csv-upload').onclick = runCsvUpload;
$('coupon-form').onsubmit = saveCoupon;

$('logout-btn').onclick = () => {
  token = '';
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  setAuthState(false);
};

if (token) bootstrap(); else setAuthState(false);
