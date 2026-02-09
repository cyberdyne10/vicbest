const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const CART_KEY = 'vicbest_cart';
const STORE_WHATSAPP_NUMBER = '2348091747685';

const summaryItems = document.getElementById('summary-items');
const summaryTotal = document.getElementById('summary-total');
const form = document.getElementById('checkout-form');
const errorBox = document.getElementById('error');

let products = [];
let cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');

async function init() {
  const [productsRes, meRes] = await Promise.all([
    fetch('/api/products'),
    fetch('/api/auth/me').catch(() => null),
  ]);

  const data = await productsRes.json();
  products = data.data || [];

  if (meRes) {
    const meData = await meRes.json();
    const user = meData.data;
    if (user) {
      form.elements.name.value = user.name || '';
      form.elements.email.value = user.email || '';
    }
  }

  renderSummary();
}

function getMergedCart() {
  return cart.map(item => {
    const p = products.find(x => x.id === item.productId);
    if (!p) return null;
    return { ...item, name: p.name, price: p.price, line: p.price * item.quantity };
  }).filter(Boolean);
}

function renderSummary() {
  if (!cart.length) {
    summaryItems.innerHTML = '<p class="text-gray-500">Your cart is empty.</p>';
    summaryTotal.textContent = NGN.format(0);
    return;
  }

  const merged = getMergedCart();

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
    name: (fd.get('name') || '').toString().trim(),
    email: (fd.get('email') || '').toString().trim(),
    phone: (fd.get('phone') || '').toString().trim(),
    address: (fd.get('address') || '').toString().trim(),
    notes: (fd.get('notes') || '').toString().trim(),
  };

  if (!customer.name || !customer.email) {
    errorBox.textContent = 'Please provide your name and email.';
    return;
  }

  const orderRes = await fetch('/api/orders/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer, items: cart }),
  });

  const orderData = await orderRes.json();
  if (!orderRes.ok) {
    errorBox.textContent = orderData.error || 'Unable to create order record';
    return;
  }

  const order = orderData.data;
  const total = Number(order.amount || 0);

  const lines = [
    'Hello Vicbest Store, I want to complete this order:',
    `Order Ref: ${order.reference}`,
    '',
    ...order.items.map((m, i) => `${i + 1}. ${m.productName} x ${m.quantity} - ${NGN.format(m.lineTotal)}`),
    '',
    `Total: ${NGN.format(total)}`,
    '',
    `Name: ${customer.name}`,
    `Email: ${customer.email}`,
    `Phone: ${customer.phone || '-'}`,
    `Address: ${customer.address || '-'}`,
    `Notes: ${customer.notes || '-'}`,
  ];

  const text = encodeURIComponent(lines.join('\n'));
  const whatsappUrl = `https://wa.me/${STORE_WHATSAPP_NUMBER}?text=${text}`;

  window.location.href = whatsappUrl;
});

init();
