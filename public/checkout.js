const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const CART_KEY = 'vicbest_cart';

const summaryItems = document.getElementById('summary-items');
const summaryTotal = document.getElementById('summary-total');
const form = document.getElementById('checkout-form');
const errorBox = document.getElementById('error');

let products = [];
let cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');

async function init() {
  const res = await fetch('/api/products');
  const data = await res.json();
  products = data.data || [];
  renderSummary();
}

function renderSummary() {
  if (!cart.length) {
    summaryItems.innerHTML = '<p class="text-gray-500">Your cart is empty.</p>';
    return;
  }

  const merged = cart.map(item => {
    const p = products.find(x => x.id === item.productId);
    if (!p) return null;
    return { ...item, name: p.name, price: p.price, line: p.price * item.quantity };
  }).filter(Boolean);

  summaryItems.innerHTML = merged.map(m => `<div class="flex justify-between"><span>${m.name} × ${m.quantity}</span><span>${NGN.format(m.line)}</span></div>`).join('');
  const total = merged.reduce((sum, m) => sum + m.line, 0);
  summaryTotal.textContent = NGN.format(total);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.textContent = '';

  if (!cart.length) {
    errorBox.textContent = 'Cart is empty.';
    return;
  }

  const fd = new FormData(form);
  const customer = {
    name: fd.get('name'),
    email: fd.get('email'),
    phone: fd.get('phone'),
    address: fd.get('address'),
    notes: fd.get('notes'),
  };

  const response = await fetch('/api/checkout/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer, items: cart }),
  });

  const data = await response.json();
  if (!response.ok || !data.status) {
    errorBox.textContent = data.error || 'Unable to initialize payment';
    return;
  }

  window.location.href = data.data.authorization_url;
});

init();