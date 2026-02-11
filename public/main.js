const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const CART_KEY = 'vicbest_cart';
const RECENTLY_VIEWED_KEY = 'vicbest_recently_viewed';
const WISHLIST_KEY = 'vicbest_wishlist';
const COMPARE_KEY = 'vicbest_compare';

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
let wishlist = JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]');
let recentViewed = JSON.parse(localStorage.getItem(RECENTLY_VIEWED_KEY) || '[]');
let compareCars = JSON.parse(localStorage.getItem(COMPARE_KEY) || '[]');
let user = null;
let activeCategory = '';
let activeHomeTab = 'all';
let searchTimer;
let flashDealEndsAt = null;
const sessionId = localStorage.getItem('vicbest_session') || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
localStorage.setItem('vicbest_session', sessionId);

function persistState() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist));
  localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(recentViewed));
  localStorage.setItem(COMPARE_KEY, JSON.stringify(compareCars));
}

async function getCurrentUser() {
  const res = await fetch('/api/auth/me').catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json();
  return data.data || null;
}

async function restoreCart() {
  if (cart.length) return;
  const res = await fetch(`/api/cart/snapshot/${encodeURIComponent(sessionId)}`).catch(() => null);
  if (!res?.ok) return;
  const data = await res.json();
  if (data.data?.cart?.length) cart = data.data.cart;
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
  renderRecentlyViewed();
  renderRecommendations();
  renderCompare();
}

function clampQty(value, max = 50) { return Math.max(1, Math.min(max, Number(value) || 1)); }
function trustBadge(label, className) { return `<span class="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-semibold ${className}">${label}</span>`; }
function isWished(id) { return wishlist.includes(id); }
function isCompared(id) { return compareCars.includes(id); }

function productCard(p) {
  const out = !p.in_stock || Number(p.stock_quantity) <= 0;
  const stockQty = Math.max(0, Number(p.stock_quantity) || 0);
  return `<div class="bg-white rounded-2xl shadow overflow-hidden border">
    <img loading="lazy" src="${p.image_url}" alt="${p.name}" class="w-full ${p.category === 'car' ? 'h-56' : 'h-36'} object-cover">
    <div class="p-4">
      <div class="flex justify-between gap-2"><h3 class="font-bold">${p.name}</h3><button data-wishlist="${p.id}" class="text-sm ${isWished(p.id) ? 'text-red-600' : 'text-gray-500'}">${isWished(p.id) ? '♥' : '♡'}</button></div>
      <p class="text-sm text-gray-500">${p.description || ''}</p>
      <div class="mt-2 flex flex-wrap gap-1.5">${trustBadge('Verified', 'bg-green-50 text-green-700 border border-green-200')} ${trustBadge(out ? 'Out of Stock' : 'In Stock', out ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-blue-50 text-blue-700 border border-blue-200')} ${trustBadge('Fast Delivery', 'bg-orange-50 text-orange-700 border border-orange-200')}</div>
      <div class="mt-2 font-semibold text-blue-900">${NGN.format(p.price)}</div>
      <p class="text-xs ${out ? 'text-red-600' : 'text-green-700'}">${out ? 'Currently unavailable' : `Only ${stockQty} left`}</p>
      <div class="mt-3 flex items-center gap-2"><div class="inline-flex items-center border rounded-lg overflow-hidden"><button type="button" data-qty-dec="${p.id}" class="px-3 py-2 text-gray-600" ${out ? 'disabled' : ''}>−</button><input data-qty-input="${p.id}" type="number" min="1" max="50" value="1" class="w-12 text-center py-2 outline-none" ${out ? 'disabled' : ''}><button type="button" data-qty-inc="${p.id}" class="px-3 py-2 text-gray-600" ${out ? 'disabled' : ''}>+</button></div><button data-id="${p.id}" class="add-cart flex-1 ${out ? 'bg-gray-300 cursor-not-allowed' : 'bg-blue-900 text-white'} py-2 rounded-lg" ${out ? 'disabled' : ''}>${out ? 'Unavailable' : 'Add to Cart'}</button></div>
      <button data-buy-now="${p.id}" class="mt-2 w-full ${out ? 'bg-gray-200 text-gray-500 cursor-not-allowed' : 'bg-orange-500 text-white'} py-2 rounded-lg font-semibold" ${out ? 'disabled' : ''}>Buy Now</button>
      ${p.category === 'car' ? `<button data-compare="${p.id}" class="mt-2 w-full border py-2 rounded-lg text-sm ${isCompared(p.id) ? 'bg-blue-50 border-blue-300 text-blue-900' : ''}">${isCompared(p.id) ? 'Selected for Compare' : 'Compare Car'}</button>` : ''}
    </div></div>`;
}

function renderProducts() {
  carsGrid.innerHTML = products.filter((p) => p.category === 'car').map(productCard).join('') || '<p class="text-gray-500">No vehicles found.</p>';
  groceriesGrid.innerHTML = products.filter((p) => p.category === 'grocery').map(productCard).join('') || '<p class="text-gray-500">No groceries found.</p>';
  document.getElementById('cars')?.classList.toggle('hidden', activeHomeTab === 'grocery');
  document.getElementById('groceries')?.classList.toggle('hidden', activeHomeTab === 'car');
  attachProductCardHandlers();
}

function simpleMiniCard(p) { return `<div class="border rounded-lg p-2.5"><p class="font-semibold text-sm line-clamp-1">${p.name}</p><p class="text-xs text-gray-500">${p.category === 'car' ? 'Vehicle' : 'Grocery'}</p><p class="font-bold mt-1 text-blue-900">${NGN.format(p.price)}</p></div>`; }

function renderRelated() {
  relatedGrid.innerHTML = products.slice(0, 4).map((p) => `<div class="bg-white border rounded-lg p-3"><p class="font-semibold text-sm">${p.name}</p><p class="text-xs text-gray-500">${p.category}</p><p class="font-bold mt-1">${NGN.format(p.price)}</p></div>`).join('');
}

function renderRecentlyViewed() {
  const host = document.getElementById('recently-viewed-grid');
  if (!host) return;
  const list = recentViewed.map((id) => products.find((p) => p.id === id)).filter(Boolean).slice(0, 6);
  host.innerHTML = list.length ? list.map(simpleMiniCard).join('') : '<p class="text-sm text-gray-500 col-span-2">No recently viewed items yet.</p>';
}

async function renderRecommendations() {
  const host = document.getElementById('smart-recommendations-grid');
  if (!host) return;
  const seed = [...new Set([...cart.map((i) => i.productId), ...recentViewed])].slice(0, 6);
  const res = await fetch(`/api/recommendations?productIds=${seed.join(',')}`).catch(() => null);
  const data = await res?.json().catch(() => ({}));
  const list = (data?.data || []).slice(0, 6);
  host.innerHTML = list.length ? list.map(simpleMiniCard).join('') : '<p class="text-sm text-gray-500 col-span-2">Add to cart to see recommendations.</p>';
}

async function fetchHomeHighlights() {
  const res = await fetch('/api/home/highlights').catch(() => null);
  const payload = res?.ok ? (await res.json()).data || {} : {};
  const topDeals = (payload.featured?.topDeals || []).slice(0, 3);
  const recent = (payload.featured?.recentlyAdded || []).slice(0, 3);
  const popular = (payload.featured?.popularThisWeek || []).slice(0, 3);
  topDealsGrid.innerHTML = (topDeals.length ? topDeals : [...products].sort((a, b) => a.price - b.price).slice(0, 3)).map(simpleMiniCard).join('');
  recentGrid.innerHTML = (recent.length ? recent : [...products].slice(-3).reverse()).map(simpleMiniCard).join('');
  popularWeekGrid.innerHTML = (popular.length ? popular : products.slice(0, 3)).map(simpleMiniCard).join('');
  ordersDeliveredIndicator.textContent = Number(payload.socialProof?.ordersDelivered || 0) > 0 ? `${Number(payload.socialProof.ordersDelivered).toLocaleString('en-NG')} successful orders delivered` : '1,000+ successful orders delivered';
  testimonialsGrid.innerHTML = (payload.socialProof?.testimonials || [{ quote: '“Very transparent process and smooth delivery.”', by: 'Chika, Lagos' }]).slice(0, 3).map((t) => `<div class="bg-white border rounded-xl p-4"><p class="font-semibold">${t.quote}</p><p class="text-xs text-gray-500 mt-2">— ${t.by}</p></div>`).join('');
}

async function fetchFlashDeals() {
  const res = await fetch('/api/home/flash-deals').catch(() => null);
  const data = res?.ok ? await res.json() : { data: {} };
  flashDealEndsAt = data.data?.endsAt ? new Date(data.data.endsAt).getTime() : Date.now() + (2 * 3600 * 1000);
  const host = document.getElementById('flash-deals-grid');
  host.innerHTML = (data.data?.products || products.slice(0, 4)).slice(0, 4).map(simpleMiniCard).join('');
}

function startFlashCountdown() {
  const el = document.getElementById('flash-deal-countdown');
  if (!el) return;
  setInterval(() => {
    const ms = Math.max(0, flashDealEndsAt - Date.now());
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    el.textContent = `Ends in ${h}:${m}:${s}`;
  }, 1000);
}

function saveCart() {
  persistState();
  fetch('/api/cart/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, cart }) }).catch(() => {});
}

function setItemQuantity(productId, quantity) { const q = clampQty(quantity); const ex = cart.find((i) => i.productId === productId); if (ex) ex.quantity = q; else cart.push({ productId, quantity: q }); saveCart(); renderCart(); }
function addToCart(productId, quantity = 1) { const q = clampQty(quantity); const ex = cart.find((i) => i.productId === productId); if (ex) ex.quantity += q; else cart.push({ productId, quantity: q }); saveCart(); renderCart(); renderRecommendations(); trackEvent('add_to_cart', { productId, quantity: q }); }
function removeItem(productId) { cart = cart.filter((i) => i.productId !== productId); saveCart(); renderCart(); renderRecommendations(); }
function getQuantityFor(productId) { return clampQty(document.querySelector(`[data-qty-input="${productId}"]`)?.value || 1); }

function rememberViewed(productId) {
  recentViewed = [productId, ...recentViewed.filter((id) => id !== productId)].slice(0, 12);
  persistState();
  renderRecentlyViewed();
  if (user) fetch('/api/me/recently-viewed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId }) }).catch(() => {});
}

function toggleWishlist(productId) {
  if (wishlist.includes(productId)) wishlist = wishlist.filter((id) => id !== productId);
  else wishlist = [productId, ...wishlist].slice(0, 40);
  persistState();
  renderProducts();
  if (user) fetch('/api/me/wishlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId }) }).catch(() => {});
}

function toggleCompare(productId) {
  if (compareCars.includes(productId)) compareCars = compareCars.filter((id) => id !== productId);
  else if (compareCars.length < 3) compareCars.push(productId);
  renderProducts();
  renderCompare();
  persistState();
}

function renderCompare() {
  const host = document.getElementById('compare-summary');
  const list = compareCars.map((id) => products.find((p) => p.id === id)).filter(Boolean);
  host.innerHTML = list.length ? `<div class="overflow-auto"><table class="w-full text-sm"><thead><tr><th class="text-left">Car</th><th class="text-left">Price</th><th class="text-left">Fuel</th><th class="text-left">Transmission</th></tr></thead><tbody>${list.map((c) => `<tr class="border-t"><td class="py-2">${c.name}</td><td>${NGN.format(c.price)}</td><td>${c.metadata?.fuel || '-'}</td><td>${c.metadata?.transmission || '-'}</td></tr>`).join('')}</tbody></table></div>` : 'No cars selected yet.';
}

function attachProductCardHandlers() {
  document.querySelectorAll('.add-cart').forEach((btn) => btn.onclick = () => { const id = Number(btn.dataset.id); rememberViewed(id); addToCart(id, getQuantityFor(id)); });
  document.querySelectorAll('[data-buy-now]').forEach((btn) => btn.onclick = () => { const id = Number(btn.dataset.buyNow); rememberViewed(id); setItemQuantity(id, getQuantityFor(id)); window.location.href = '/checkout'; });
  document.querySelectorAll('[data-qty-dec]').forEach((btn) => btn.onclick = () => { const i = document.querySelector(`[data-qty-input="${btn.dataset.qtyDec}"]`); i.value = clampQty(Number(i.value) - 1); });
  document.querySelectorAll('[data-qty-inc]').forEach((btn) => btn.onclick = () => { const i = document.querySelector(`[data-qty-input="${btn.dataset.qtyInc}"]`); i.value = clampQty(Number(i.value) + 1); });
  document.querySelectorAll('[data-wishlist]').forEach((btn) => btn.onclick = () => toggleWishlist(Number(btn.dataset.wishlist)));
  document.querySelectorAll('[data-compare]').forEach((btn) => btn.onclick = () => toggleCompare(Number(btn.dataset.compare)));
}

function openCart() { document.getElementById('cart-drawer').classList.remove('translate-x-full'); document.getElementById('cart-overlay').classList.remove('hidden'); }
function closeCart() { document.getElementById('cart-drawer').classList.add('translate-x-full'); document.getElementById('cart-overlay').classList.add('hidden'); }

function renderCart() {
  const count = cart.reduce((s, i) => s + i.quantity, 0);
  ['cart-count', 'cart-count-mobile'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = count; });
  const merged = cart.map((item) => { const p = products.find((x) => x.id === item.productId); return p ? { ...item, p, line: p.price * item.quantity } : null; }).filter(Boolean);
  cartItems.innerHTML = merged.length ? merged.map((m) => `<div class="border rounded-lg p-3"><p class="font-semibold">${m.p.name}</p><div class="flex justify-between mt-2"><span>${NGN.format(m.line)}</span><button data-remove="${m.p.id}" class="text-red-600 text-sm">Remove</button></div></div>`).join('') : '<p class="text-gray-500">Your cart is empty.</p>';
  const subtotal = merged.reduce((s, m) => s + m.line, 0); cartTotal.textContent = NGN.format(subtotal);
  if (mobileCartBar) { mobileCartBar.classList.toggle('hidden', count === 0); mobileCartItems.textContent = String(count); mobileCartSubtotal.textContent = NGN.format(subtotal); }
  document.querySelectorAll('[data-remove]').forEach((btn) => btn.onclick = () => removeItem(Number(btn.dataset.remove)));
}

async function loadWishlistAndRecentForUser() {
  if (!user) return;
  const [wishlistRes, recentRes] = await Promise.all([fetch('/api/me/wishlist').catch(() => null), fetch('/api/me/recently-viewed').catch(() => null)]);
  if (wishlistRes?.ok) wishlist = ((await wishlistRes.json()).data || []).map((p) => p.id);
  if (recentRes?.ok) recentViewed = ((await recentRes.json()).data || []).map((p) => p.id);
  persistState();
}

async function initDeliveryEta() {
  const select = document.getElementById('eta-zone');
  const result = document.getElementById('eta-result');
  if (!select) return;
  const zonesRes = await fetch('/api/delivery/zones').catch(() => null);
  const zones = zonesRes?.ok ? (await zonesRes.json()).data || [] : [];
  select.innerHTML = zones.length ? zones.map((z) => `<option value="${z.code}" data-covered="${z.is_covered}">${z.name}</option>`).join('') : '<option value="lagos_mainland">Lagos Mainland</option><option value="lagos_island">Lagos Island</option>';
  document.getElementById('eta-check-btn')?.addEventListener('click', () => {
    const val = select.value;
    const etaMap = { lagos_mainland: '2 - 6 hours', lagos_island: '4 - 10 hours', abuja: '1 - 2 days' };
    result.textContent = `Estimated delivery for selected location: ${etaMap[val] || '2 - 3 days'} (subject to stock confirmation).`;
  });
}

function initExitIntent() {
  const banner = document.getElementById('exit-offer-banner');
  let shown = sessionStorage.getItem('vicbest_exit_offer') === '1';
  document.addEventListener('mouseout', (e) => {
    if (shown || e.clientY > 20) return;
    banner.classList.remove('hidden');
    shown = true;
    sessionStorage.setItem('vicbest_exit_offer', '1');
  });
  document.getElementById('close-exit-offer-btn')?.addEventListener('click', () => banner.classList.add('hidden'));
  document.getElementById('copy-exit-coupon-btn')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText('WELCOME5').catch(() => {});
    document.getElementById('copy-exit-coupon-btn').textContent = 'Copied';
  });
}

async function trackEvent(eventType, payload = {}) {
  await fetch('/api/analytics/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType, sessionId, payload }),
  }).catch(() => {});
}

function initPwa() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

function initUI() {
  document.getElementById('open-cart-btn')?.addEventListener('click', openCart);
  document.getElementById('open-cart-btn-mobile')?.addEventListener('click', openCart);
  document.getElementById('mobile-cart-open')?.addEventListener('click', openCart);
  document.getElementById('close-cart-btn')?.addEventListener('click', closeCart);
  document.getElementById('cart-overlay')?.addEventListener('click', closeCart);
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => document.getElementById('mobile-menu').classList.toggle('hidden'));
  document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => { activeCategory = chip.dataset.category || ''; document.querySelectorAll('.chip').forEach((c) => c.className = 'chip px-3 py-2 text-sm rounded-full bg-gray-100'); chip.className = 'chip px-3 py-2 text-sm rounded-full bg-blue-900 text-white'; fetchProducts(); }));
  stockToggle?.addEventListener('change', fetchProducts);
  searchInput?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(fetchProducts, 250); });
  document.querySelectorAll('.home-tab').forEach((btn) => btn.addEventListener('click', () => { activeHomeTab = btn.dataset.homeTab || 'all'; document.querySelectorAll('.home-tab').forEach((x) => x.className = 'home-tab px-3 py-2 rounded-full bg-gray-100 text-sm'); btn.className = 'home-tab px-3 py-2 rounded-full bg-blue-900 text-white text-sm'; renderProducts(); }));
  document.getElementById('continue-shopping-btn')?.addEventListener('click', () => window.scrollTo({ top: 600, behavior: 'smooth' }));
  document.getElementById('clear-compare-btn')?.addEventListener('click', () => { compareCars = []; persistState(); renderProducts(); renderCompare(); });
}

(async function boot() {
  const restoreToken = new URLSearchParams(window.location.search).get('restore');
  if (restoreToken) {
    const res = await fetch(`/api/cart/restore/${encodeURIComponent(restoreToken)}`).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (Array.isArray(data?.data?.cart) && data.data.cart.length) {
      cart = data.data.cart;
      persistState();
    }
  }

  await restoreCart();
  user = await getCurrentUser();
  await loadWishlistAndRecentForUser();
  initUI();
  initPwa();
  await fetchProducts();
  await fetchHomeHighlights();
  await fetchFlashDeals();
  await initDeliveryEta();
  initExitIntent();
  startFlashCountdown();
  trackEvent('view_home', { path: location.pathname });
})();

