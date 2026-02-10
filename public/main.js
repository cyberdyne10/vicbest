const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const CART_KEY = 'vicbest_cart';
const carsGrid = document.getElementById('cars-grid');
const groceriesGrid = document.getElementById('groceries-grid');
const relatedGrid = document.getElementById('related-products');
const cartItems = document.getElementById('cart-items');
const cartTotal = document.getElementById('cart-total');
const searchInput = document.getElementById('product-search');
const stockToggle = document.getElementById('in-stock-only');
let cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
let products = []; let activeCategory = ''; let activeHomeTab = 'all'; let searchTimer;
const sessionId = localStorage.getItem('vicbest_session') || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
localStorage.setItem('vicbest_session', sessionId);

async function restoreCart() {
  if (cart.length) return;
  const res = await fetch(`/api/cart/snapshot/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (!res?.ok) return;
  const data = await res.json();
  if (data.data?.cart?.length) { cart = data.data.cart; saveCart(); }
}

async function fetchProducts() {
  const params = new URLSearchParams();
  if (activeCategory) params.set('category', activeCategory);
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  if (stockToggle.checked) params.set('inStock', '1');
  const res = await fetch(`/api/products?${params.toString()}`);
  const data = await res.json(); products = data.data || [];
  renderProducts(); renderCart(); renderRelated();
}

function productCard(p) {
  const out = !p.in_stock || Number(p.stock_quantity) <= 0;
  return `<div class="bg-white rounded-2xl shadow overflow-hidden border"><img loading="lazy" src="${p.image_url}" alt="${p.name}" class="w-full ${p.category === 'car' ? 'h-56' : 'h-36'} object-cover"><div class="p-4"><h3 class="font-bold">${p.name}</h3><p class="text-sm text-gray-500">${p.description || ''}</p><div class="mt-2 font-semibold text-blue-900">${NGN.format(p.price)}</div><p class="text-xs ${out ? 'text-red-600' : 'text-green-600'}">${out ? 'Out of stock' : `In stock: ${p.stock_quantity ?? '-'}`}</p><button data-id="${p.id}" class="add-cart mt-3 w-full ${out ? 'bg-gray-300 cursor-not-allowed' : 'bg-blue-900 text-white'} py-2 rounded-lg" ${out ? 'disabled' : ''}>${out ? 'Unavailable' : 'Add to Cart'}</button></div></div>`;
}

function renderProducts() {
  carsGrid.innerHTML = products.filter((p) => p.category === 'car').map(productCard).join('') || '<p class="text-gray-500">No vehicles found.</p>';
  groceriesGrid.innerHTML = products.filter((p) => p.category === 'grocery').map(productCard).join('') || '<p class="text-gray-500">No groceries found.</p>';
  const carsSection = document.getElementById('cars');
  const grocerySection = document.getElementById('groceries');
  if (carsSection && grocerySection) {
    carsSection.classList.toggle('hidden', activeHomeTab === 'grocery');
    grocerySection.classList.toggle('hidden', activeHomeTab === 'car');
  }
  document.querySelectorAll('.add-cart').forEach((btn) => btn.addEventListener('click', () => addToCart(Number(btn.dataset.id))));
}

function renderRelated() {
  const list = products.slice(0, 4);
  relatedGrid.innerHTML = list.map((p) => `<div class="bg-white border rounded-lg p-3"><p class="font-semibold text-sm">${p.name}</p><p class="text-xs text-gray-500">${p.category}</p><p class="font-bold mt-1">${NGN.format(p.price)}</p></div>`).join('');
}

function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  fetch('/api/cart/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, cart }) }).catch(() => {});
}

function addToCart(productId) { const x = cart.find((i) => i.productId === productId); if (x) x.quantity += 1; else cart.push({ productId, quantity: 1 }); saveCart(); renderCart(); }
function removeItem(productId) { cart = cart.filter((i) => i.productId !== productId); saveCart(); renderCart(); }

function renderCart() {
  const count = cart.reduce((s, i) => s + i.quantity, 0);
  ['cart-count', 'cart-count-mobile'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = count; });
  const merged = cart.map((item) => { const p = products.find((x) => x.id === item.productId); return p ? { ...item, p, line: p.price * item.quantity } : null; }).filter(Boolean);
  cartItems.innerHTML = merged.length ? merged.map((m) => `<div class="border rounded-lg p-3"><p class="font-semibold">${m.p.name}</p><div class="flex justify-between mt-2"><span>${NGN.format(m.line)}</span><button data-remove="${m.p.id}" class="text-red-600 text-sm">Remove</button></div></div>`).join('') : '<p class="text-gray-500">Your cart is empty.</p>';
  cartTotal.textContent = NGN.format(merged.reduce((s, m) => s + m.line, 0));
  document.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => removeItem(Number(btn.dataset.remove))));
}

function initUI() {
  document.getElementById('open-cart-btn')?.addEventListener('click', () => document.getElementById('cart-drawer').classList.remove('translate-x-full'));
  document.getElementById('open-cart-btn-mobile')?.addEventListener('click', () => document.getElementById('cart-drawer').classList.remove('translate-x-full'));
  document.getElementById('close-cart-btn')?.addEventListener('click', () => document.getElementById('cart-drawer').classList.add('translate-x-full'));
  document.getElementById('cart-overlay')?.addEventListener('click', () => document.getElementById('cart-drawer').classList.add('translate-x-full'));
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => document.getElementById('mobile-menu').classList.toggle('hidden'));
  document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    activeCategory = chip.dataset.category || '';
    document.querySelectorAll('.chip').forEach((c) => c.className = 'chip px-3 py-2 text-sm rounded-full bg-gray-100');
    chip.className = 'chip px-3 py-2 text-sm rounded-full bg-blue-900 text-white';
    fetchProducts();
  }));
  stockToggle?.addEventListener('change', fetchProducts);
  searchInput?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(fetchProducts, 250); });
  document.querySelectorAll('.home-tab').forEach((btn) => btn.addEventListener('click', () => {
    activeHomeTab = btn.dataset.homeTab || 'all';
    document.querySelectorAll('.home-tab').forEach((x) => x.className = 'home-tab px-3 py-2 rounded-full bg-gray-100 text-sm');
    btn.className = 'home-tab px-3 py-2 rounded-full bg-blue-900 text-white text-sm';
    renderProducts();
  }));
}

(async function boot() { await restoreCart(); initUI(); await fetchProducts(); })();