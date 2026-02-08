const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const CART_KEY = 'vicbest_cart';

const carsGrid = document.getElementById('cars-grid');
const groceriesGrid = document.getElementById('groceries-grid');
const cartCount = document.getElementById('cart-count');
const cartItems = document.getElementById('cart-items');
const cartTotal = document.getElementById('cart-total');
const drawer = document.getElementById('cart-drawer');
const overlay = document.getElementById('cart-overlay');

const cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
let products = [];

const sessionId = localStorage.getItem('vicbest_session') || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
localStorage.setItem('vicbest_session', sessionId);

async function fetchProducts() {
  const res = await fetch('/api/products');
  const data = await res.json();
  products = data.data || [];
  renderProducts();
  renderCart();
}

function productCard(p) {
  const button = `<button data-id="${p.id}" class="add-cart mt-3 w-full bg-blue-900 text-white py-2 rounded-lg">Add to Cart</button>`;
  if (p.category === 'car') {
    return `<div class="bg-white rounded-2xl shadow-lg overflow-hidden border border-gray-100">
      <img src="${p.image_url}" alt="${p.name}" class="w-full h-56 object-cover">
      <div class="p-5">
        <h3 class="text-xl font-bold">${p.name}</h3>
        <p class="text-gray-500 text-sm mt-1">${p.description || ''}</p>
        <div class="mt-4 font-bold text-blue-900 text-2xl">${NGN.format(p.price)}</div>
        ${button}
      </div>
    </div>`;
  }
  return `<div class="bg-white p-4 rounded-2xl shadow border border-gray-100">
    <img src="${p.image_url}" alt="${p.name}" class="w-full h-36 object-cover rounded-lg mb-3">
    <h3 class="font-bold">${p.name}</h3>
    <div class="mt-2 font-semibold text-green-600">${NGN.format(p.price)}</div>
    ${button}
  </div>`;
}

function renderProducts() {
  carsGrid.innerHTML = products.filter(p => p.category === 'car').map(productCard).join('');
  groceriesGrid.innerHTML = products.filter(p => p.category === 'grocery').map(productCard).join('');

  document.querySelectorAll('.add-cart').forEach(btn => {
    btn.addEventListener('click', () => addToCart(Number(btn.dataset.id)));
  });
}

function addToCart(productId) {
  const existing = cart.find(i => i.productId === productId);
  if (existing) existing.quantity += 1;
  else cart.push({ productId, quantity: 1 });
  saveCart();
  renderCart();
}

function removeItem(productId) {
  const idx = cart.findIndex(i => i.productId === productId);
  if (idx >= 0) cart.splice(idx, 1);
  saveCart();
  renderCart();
}

function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  fetch('/api/cart/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, cart })
  }).catch(() => {});
}

function renderCart() {
  cartCount.textContent = cart.reduce((sum, i) => sum + i.quantity, 0);
  if (cart.length === 0) {
    cartItems.innerHTML = '<p class="text-gray-500">Your cart is empty.</p>';
    cartTotal.textContent = NGN.format(0);
    return;
  }

  const merged = cart.map(item => {
    const p = products.find(x => x.id === item.productId);
    if (!p) return null;
    return { ...item, product: p, line: p.price * item.quantity };
  }).filter(Boolean);

  cartItems.innerHTML = merged.map(m => `<div class="border rounded-lg p-3">
      <p class="font-semibold">${m.product.name}</p>
      <p class="text-sm text-gray-500">Qty: ${m.quantity}</p>
      <div class="flex justify-between mt-2">
        <span>${NGN.format(m.line)}</span>
        <button data-remove="${m.product.id}" class="text-red-600 text-sm">Remove</button>
      </div>
    </div>`).join('');

  const total = merged.reduce((sum, m) => sum + m.line, 0);
  cartTotal.textContent = NGN.format(total);

  document.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeItem(Number(btn.dataset.remove)));
  });
}

document.getElementById('open-cart-btn').addEventListener('click', () => {
  drawer.classList.remove('translate-x-full');
  overlay.classList.remove('hidden');
});
document.getElementById('close-cart-btn').addEventListener('click', closeDrawer);
overlay.addEventListener('click', closeDrawer);
function closeDrawer() {
  drawer.classList.add('translate-x-full');
  overlay.classList.add('hidden');
}

fetchProducts();