const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const ADMIN_TOKEN_KEY = 'vicbest_admin_token';
const ORDER_STATUSES = ['pending_payment', 'paid', 'processing', 'delivered', 'cancelled'];

const loginCard = document.getElementById('login-card');
const dashboard = document.getElementById('dashboard');
const logoutBtn = document.getElementById('logout-btn');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const productsTbody = document.getElementById('products-tbody');
const ordersWrap = document.getElementById('orders-wrap');
const orderFilter = document.getElementById('order-filter');

const productForm = document.getElementById('product-form');
const productFormMsg = document.getElementById('product-form-msg');

let products = [];
let token = localStorage.getItem(ADMIN_TOKEN_KEY) || '';

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function setAuthState(isLoggedIn) {
  loginCard.classList.toggle('hidden', isLoggedIn);
  dashboard.classList.toggle('hidden', !isLoggedIn);
  logoutBtn.classList.toggle('hidden', !isLoggedIn);
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function clearLoginError() {
  loginError.textContent = '';
  loginError.classList.add('hidden');
}

async function login(password) {
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  token = data.token;
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

function resetProductForm() {
  document.getElementById('product-id').value = '';
  document.getElementById('product-name').value = '';
  document.getElementById('product-category').value = 'car';
  document.getElementById('product-price').value = '';
  document.getElementById('product-image').value = '';
  document.getElementById('product-description').value = '';
  document.getElementById('product-metadata').value = '{}';
  document.getElementById('product-stock').checked = true;
  productFormMsg.textContent = '';
}

function fillProductForm(p) {
  document.getElementById('product-id').value = p.id;
  document.getElementById('product-name').value = p.name;
  document.getElementById('product-category').value = p.category;
  document.getElementById('product-price').value = p.price;
  document.getElementById('product-image').value = p.image_url || '';
  document.getElementById('product-description').value = p.description || '';
  document.getElementById('product-metadata').value = JSON.stringify(p.metadata || {}, null, 2);
  document.getElementById('product-stock').checked = Boolean(p.in_stock);
}

async function fetchProducts() {
  const res = await fetch('/api/admin/products', { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load products');
  products = data.data || [];
  productsTbody.innerHTML = products.map((p) => `
    <tr class="border-b align-top">
      <td class="py-2 pr-2">${p.id}</td>
      <td class="py-2 pr-2 font-medium">${p.name}</td>
      <td class="py-2 pr-2">${p.category}</td>
      <td class="py-2 pr-2">${NGN.format(p.price)}</td>
      <td class="py-2 pr-2">${p.in_stock ? 'In stock' : 'Out of stock'}</td>
      <td class="py-2 space-x-2">
        <button data-edit="${p.id}" class="text-blue-700 font-semibold">Edit</button>
        <button data-del="${p.id}" class="text-red-700 font-semibold">Delete</button>
      </td>
    </tr>
  `).join('');

  document.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const product = products.find((x) => x.id === Number(btn.dataset.edit));
      if (product) fillProductForm(product);
    });
  });

  document.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this product?')) return;
      const id = Number(btn.dataset.del);
      const res = await fetch(`/api/admin/products/${id}`, { method: 'DELETE', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Delete failed');
      await fetchProducts();
    });
  });
}

function orderCard(order) {
  const itemRows = (order.items || [])
    .map((i) => `<li>${i.quantity} × ${i.product_name} <span class="text-gray-500">(${NGN.format(i.line_total)})</span></li>`)
    .join('');

  const statusOptions = ORDER_STATUSES
    .map((status) => `<option value="${status}" ${order.status === status ? 'selected' : ''}>${status}</option>`)
    .join('');

  return `
    <div class="border rounded-xl p-4">
      <div class="flex flex-wrap justify-between gap-2">
        <div>
          <p class="font-bold">Order #${order.id} • ${order.payment_reference || 'N/A'}</p>
          <p class="text-sm text-gray-600">${order.customer_name} • ${order.customer_email}</p>
          <p class="text-sm text-gray-600">${order.customer_phone || 'No phone'} • ${new Date(order.created_at).toLocaleString()}</p>
        </div>
        <div class="text-right">
          <p class="font-semibold text-blue-900">${NGN.format(order.amount)}</p>
          <select data-order-status="${order.id}" class="border rounded-lg px-2 py-1 text-sm mt-1">${statusOptions}</select>
        </div>
      </div>
      <ul class="mt-3 text-sm list-disc pl-5 space-y-1">${itemRows || '<li>No items</li>'}</ul>
    </div>
  `;
}

async function fetchOrders() {
  const filter = orderFilter.value;
  const q = filter ? `?status=${encodeURIComponent(filter)}` : '';
  const res = await fetch(`/api/admin/orders${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load orders');
  const orders = data.data || [];
  ordersWrap.innerHTML = orders.length ? orders.map(orderCard).join('') : '<p class="text-gray-500">No orders yet.</p>';

  document.querySelectorAll('[data-order-status]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = Number(sel.dataset.orderStatus);
      const status = sel.value;
      const res = await fetch(`/api/admin/orders/${id}/status`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Status update failed');
        return;
      }
    });
  });
}

async function bootstrapDashboard() {
  setAuthState(true);
  try {
    await Promise.all([fetchProducts(), fetchOrders()]);
  } catch (err) {
    if ((err.message || '').toLowerCase().includes('unauthorized')) {
      token = '';
      localStorage.removeItem(ADMIN_TOKEN_KEY);
      setAuthState(false);
      return;
    }
    alert(err.message || 'Failed to load dashboard');
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearLoginError();
  try {
    await login(document.getElementById('admin-password').value);
    await bootstrapDashboard();
  } catch (err) {
    showLoginError(err.message || 'Login failed');
  }
});

productForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  productFormMsg.className = 'text-sm mt-3';
  try {
    const id = document.getElementById('product-id').value;
    const payload = {
      name: document.getElementById('product-name').value,
      category: document.getElementById('product-category').value,
      price: Number(document.getElementById('product-price').value),
      image_url: document.getElementById('product-image').value,
      description: document.getElementById('product-description').value,
      metadata: document.getElementById('product-metadata').value,
      in_stock: document.getElementById('product-stock').checked,
    };

    const res = await fetch(id ? `/api/admin/products/${id}` : '/api/admin/products', {
      method: id ? 'PUT' : 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');

    productFormMsg.textContent = `Product ${id ? 'updated' : 'created'} successfully.`;
    productFormMsg.classList.add('text-green-700');
    resetProductForm();
    await fetchProducts();
  } catch (err) {
    productFormMsg.textContent = err.message || 'Save failed';
    productFormMsg.classList.add('text-red-700');
  }
});

document.getElementById('reset-product').addEventListener('click', resetProductForm);
orderFilter.addEventListener('change', fetchOrders);

logoutBtn.addEventListener('click', () => {
  token = '';
  localStorage.removeItem(ADMIN_TOKEN_KEY);
  setAuthState(false);
});

if (token) {
  bootstrapDashboard();
} else {
  setAuthState(false);
}
