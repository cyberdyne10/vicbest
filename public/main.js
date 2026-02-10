const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const CART_KEY = 'vicbest_cart';

const carsGrid = document.getElementById('cars-grid');
const groceriesGrid = document.getElementById('groceries-grid');
const relatedGrid = document.getElementById('related-products');
const cartItems = document.getElementById('cart-items');
const cartTotal = document.getElementById('cart-total');
const searchInput = document.getElementById('product-search');
const stockToggle = document.getElementById('in-stock-only');
const topDealsGrid = document.getElementById('top-deals-grid');
const recentGrid = document.getElementById('recently-added-grid');
const popularWeekGrid = document.getElementById('popular-week-grid');
const testimonialsGrid = document.getElementById('testimonials-grid');
const ordersDeliveredIndicator = document.getElementById('orders-delivered-indicator');
const mobileCartBar = document.getElementById('mobile-cart-bar');
const mobileCartItems = document.getElementById('mobile-cart-items');
const mobileCartSubtotal = document.getElementById('mobile-cart-subtotal');

let cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
let products = [];
let activeCategory = '';
let activeHomeTab = 'all';
let searchTimer;
const sessionId = localStorage.getItem('vicbest_session') || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
localStorage.setItem('vicbest_session', sessionId);

async function restoreCart() {
  if (cart.length) return;
  const res = await fetch(`/api/cart/snapshot/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (!res?.ok) return;
  const data = await res.json();
  if (data.data?.cart?.length) {
    cart = data.data.cart;
    saveCart();
  }
}

async function fetchProducts() {
  const params = new URLSearchParams();
  if (activeCategory) params.set('category', activeCategory);
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  if (stockToggle.checked) params.set('inStock', '1');
  const res = await fetch(`/api/products?${params.toString()}`);
  const data = await res.json();
  products = data.data || [];
  renderProducts();
  renderCart();
  renderRelated();
}

function clampQty(value, max = 50) {
  return Math.max(1, Math.min(max, Number(value) || 1));
}

function trustBadge(label, className) {
  return `<span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-semibold ${className}">${label}</span>`;
}

function productCard(p) {
  const out = !p.in_stock || Number(p.stock_quantity) <= 0;
  const stockQty = Math.max(0, Number(p.stock_quantity) || 0);
  return `<div class="bg-white rounded-2xl shadow overflow-hidden border">
    <img loading="lazy" src="${p.image_url}" alt="${p.name}" class="w-full ${p.category === 'car' ? 'h-56' : 'h-36'} object-cover">
    <div class="p-4">
      <h3 class="font-bold">${p.name}</h3>
      <p class="text-sm text-gray-500">${p.description || ''}</p>
      <div class="mt-2 flex flex-wrap gap-1.5">
        ${trustBadge('Verified', 'bg-green-50 text-green-700 border border-green-200')}
        ${trustBadge(out ? 'Out of Stock' : 'In Stock', out ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-blue-50 text-blue-700 border border-blue-200')}
        ${trustBadge('Fast Delivery', 'bg-orange-50 text-orange-700 border border-orange-200')}
      </div>
      <div class="mt-2 font-semibold text-blue-900">${NGN.format(p.price)}</div>
      <p class="text-xs ${out ? 'text-red-600' : 'text-green-700'}">${out ? 'Currently unavailable' : `Only ${stockQty} left`}</p>
      <div class="mt-3 flex items-center gap-2">
        <label class="sr-only" for="qty-${p.id}">Quantity</label>
        <div class="inline-flex items-center border rounded-lg overflow-hidden">
          <button type="button" data-qty-dec="${p.id}" class="px-3 py-2 text-gray-600 hover:bg-gray-50" ${out ? 'disabled' : ''}>−</button>
          <input id="qty-${p.id}" data-qty-input="${p.id}" type="number" min="1" max="50" value="1" class="w-12 text-center py-2 outline-none" ${out ? 'disabled' : ''}>
          <button type="button" data-qty-inc="${p.id}" class="px-3 py-2 text-gray-600 hover:bg-gray-50" ${out ? 'disabled' : ''}>+</button>
        </div>
        <button data-id="${p.id}" class="add-cart flex-1 ${out ? 'bg-gray-300 cursor-not-allowed' : 'bg-blue-900 text-white'} py-2 rounded-lg" ${out ? 'disabled' : ''}>${out ? 'Unavailable' : 'Add to Cart'}</button>
      </div>
      <button data-buy-now="${p.id}" class="mt-2 w-full ${out ? 'bg-gray-200 text-gray-500 cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-600 text-white'} py-2 rounded-lg font-semibold" ${out ? 'disabled' : ''}>Buy Now</button>
      <p class="text-[11px] text-gray-500 mt-2">Covered by easy returns and warranty support on eligible purchases.</p>
    </div>
  </div>`;
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

  attachProductCardHandlers();
}

function simpleMiniCard(p) {
  return `<div class="border rounded-lg p-2.5"><p class="font-semibold text-sm line-clamp-1">${p.name}</p><p class="text-xs text-gray-500">${p.category === 'car' ? 'Vehicle' : 'Grocery'}</p><p class="font-bold mt-1 text-blue-900">${NGN.format(p.price)}</p></div>`;
}

function renderRelated() {
  const list = products.slice(0, 4);
  relatedGrid.innerHTML = list.map((p) => `<div class="bg-white border rounded-lg p-3"><p class="font-semibold text-sm">${p.name}</p><p class="text-xs text-gray-500">${p.category}</p><p class="font-bold mt-1">${NGN.format(p.price)}</p></div>`).join('');
}

function renderFeaturedSections(data = {}) {
  const topDeals = (data.topDeals || []).slice(0, 3);
  const recent = (data.recentlyAdded || []).slice(0, 3);
  const popular = (data.popularThisWeek || []).slice(0, 3);

  const fallbackDeals = [...products].sort((a, b) => a.price - b.price).slice(0, 3);
  const fallbackRecent = [...products].slice(-3).reverse();
  const fallbackPopular = [...products].filter((p) => Number(p.in_stock) === 1).slice(0, 3);

  topDealsGrid.innerHTML = (topDeals.length ? topDeals : fallbackDeals).map(simpleMiniCard).join('') || '<p class="text-sm text-gray-500">No deals available yet.</p>';
  recentGrid.innerHTML = (recent.length ? recent : fallbackRecent).map(simpleMiniCard).join('') || '<p class="text-sm text-gray-500">No recent products yet.</p>';
  popularWeekGrid.innerHTML = (popular.length ? popular : fallbackPopular).map(simpleMiniCard).join('') || '<p class="text-sm text-gray-500">No popularity data yet.</p>';
}

function renderSocialProof(data = {}) {
  const delivered = Number(data.ordersDelivered || 0);
  ordersDeliveredIndicator.textContent = delivered > 0 ? `${delivered.toLocaleString('en-NG')} successful orders delivered` : '1,000+ successful orders delivered';

  const fallbackTestimonials = [
    { quote: '“Very transparent process and smooth delivery.”', by: 'Chika, Lagos' },
    { quote: '“Got my groceries same day. Fresh and neatly packed.”', by: 'Tunde, Ikeja' },
    { quote: '“The car condition matched exactly what was posted.”', by: 'Ada, Abuja' },
  ];
  const testimonials = (data.testimonials || []).slice(0, 3);
  const shown = testimonials.length ? testimonials : fallbackTestimonials;
  testimonialsGrid.innerHTML = shown.map((t) => `<div class="bg-white border rounded-xl p-4"><p class="font-semibold">${t.quote}</p><p class="text-xs text-gray-500 mt-2">— ${t.by}</p></div>`).join('');
}

async function fetchHomeHighlights() {
  const res = await fetch('/api/home/highlights').catch(() => null);
  if (!res?.ok) {
    renderFeaturedSections();
    renderSocialProof();
    return;
  }
  const data = await res.json();
  const payload = data.data || {};
  renderFeaturedSections(payload.featured || {});
  renderSocialProof(payload.socialProof || {});
}

function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  fetch('/api/cart/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, cart }) }).catch(() => {});
}

function setItemQuantity(productId, quantity) {
  const qty = clampQty(quantity);
  const existing = cart.find((i) => i.productId === productId);
  if (existing) existing.quantity = qty;
  else cart.push({ productId, quantity: qty });
  saveCart();
  renderCart();
}

function addToCart(productId, quantity = 1) {
  const qty = clampQty(quantity);
  const existing = cart.find((i) => i.productId === productId);
  if (existing) existing.quantity += qty;
  else cart.push({ productId, quantity: qty });
  saveCart();
  renderCart();
}

function removeItem(productId) {
  cart = cart.filter((i) => i.productId !== productId);
  saveCart();
  renderCart();
}

function getQuantityFor(productId) {
  const input = document.querySelector(`[data-qty-input="${productId}"]`);
  return clampQty(input?.value || 1);
}

function attachProductCardHandlers() {
  document.querySelectorAll('.add-cart').forEach((btn) => btn.addEventListener('click', () => {
    const id = Number(btn.dataset.id);
    addToCart(id, getQuantityFor(id));
  }));

  document.querySelectorAll('[data-buy-now]').forEach((btn) => btn.addEventListener('click', () => {
    const id = Number(btn.dataset.buyNow);
    setItemQuantity(id, getQuantityFor(id));
    window.location.href = '/checkout';
  }));

  document.querySelectorAll('[data-qty-dec]').forEach((btn) => btn.addEventListener('click', () => {
    const id = Number(btn.dataset.qtyDec);
    const input = document.querySelector(`[data-qty-input="${id}"]`);
    input.value = clampQty(Number(input.value) - 1);
  }));

  document.querySelectorAll('[data-qty-inc]').forEach((btn) => btn.addEventListener('click', () => {
    const id = Number(btn.dataset.qtyInc);
    const input = document.querySelector(`[data-qty-input="${id}"]`);
    input.value = clampQty(Number(input.value) + 1);
  }));

  document.querySelectorAll('[data-qty-input]').forEach((input) => input.addEventListener('change', () => {
    input.value = clampQty(input.value);
  }));
}

function openCart() {
  document.getElementById('cart-drawer').classList.remove('translate-x-full');
  document.getElementById('cart-overlay').classList.remove('hidden');
}

function closeCart() {
  document.getElementById('cart-drawer').classList.add('translate-x-full');
  document.getElementById('cart-overlay').classList.add('hidden');
}

function renderCart() {
  const count = cart.reduce((s, i) => s + i.quantity, 0);
  ['cart-count', 'cart-count-mobile'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = count;
  });

  const merged = cart.map((item) => {
    const p = products.find((x) => x.id === item.productId);
    return p ? { ...item, p, line: p.price * item.quantity } : null;
  }).filter(Boolean);

  cartItems.innerHTML = merged.length
    ? merged.map((m) => `<div class="border rounded-lg p-3"><p class="font-semibold">${m.p.name}</p><div class="flex justify-between mt-2"><span>${NGN.format(m.line)}</span><button data-remove="${m.p.id}" class="text-red-600 text-sm">Remove</button></div></div>`).join('')
    : '<p class="text-gray-500">Your cart is empty.</p>';

  const subtotal = merged.reduce((s, m) => s + m.line, 0);
  cartTotal.textContent = NGN.format(subtotal);

  if (mobileCartBar) {
    mobileCartBar.classList.toggle('hidden', count === 0);
    mobileCartItems.textContent = String(count);
    mobileCartSubtotal.textContent = NGN.format(subtotal);
  }

  document.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => removeItem(Number(btn.dataset.remove))));
}

function initUI() {
  document.getElementById('open-cart-btn')?.addEventListener('click', openCart);
  document.getElementById('open-cart-btn-mobile')?.addEventListener('click', openCart);
  document.getElementById('mobile-cart-open')?.addEventListener('click', openCart);
  document.getElementById('close-cart-btn')?.addEventListener('click', closeCart);
  document.getElementById('cart-overlay')?.addEventListener('click', closeCart);

  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => document.getElementById('mobile-menu').classList.toggle('hidden'));

  document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    activeCategory = chip.dataset.category || '';
    document.querySelectorAll('.chip').forEach((c) => c.className = 'chip px-3 py-2 text-sm rounded-full bg-gray-100');
    chip.className = 'chip px-3 py-2 text-sm rounded-full bg-blue-900 text-white';
    fetchProducts();
  }));

  stockToggle?.addEventListener('change', fetchProducts);
  searchInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(fetchProducts, 250);
  });

  document.querySelectorAll('.home-tab').forEach((btn) => btn.addEventListener('click', () => {
    activeHomeTab = btn.dataset.homeTab || 'all';
    document.querySelectorAll('.home-tab').forEach((x) => x.className = 'home-tab px-3 py-2 rounded-full bg-gray-100 text-sm');
    btn.className = 'home-tab px-3 py-2 rounded-full bg-blue-900 text-white text-sm';
    renderProducts();
  }));
}

(async function boot() {
  await restoreCart();
  initUI();
  await fetchProducts();
  await fetchHomeHighlights();
})();
