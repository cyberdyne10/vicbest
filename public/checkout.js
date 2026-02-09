const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const CART_KEY = 'vicbest_cart'; const PREFS_KEY = 'vicbest_checkout_prefs';
const STORE_WHATSAPP_NUMBER = '2348091747685';
const summaryItems = document.getElementById('summary-items'); const summaryTotal = document.getElementById('summary-total');
const form = document.getElementById('checkout-form'); const errorBox = document.getElementById('error');
let products = []; let cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]');

function getMergedCart() { return cart.map((item) => { const p = products.find((x) => x.id === item.productId); return p ? { ...item, name: p.name, price: p.price, line: p.price * item.quantity } : null; }).filter(Boolean); }
function renderSummary() { const merged = getMergedCart(); summaryItems.innerHTML = merged.length ? merged.map((m) => `<div class="flex justify-between"><span>${m.name} × ${m.quantity}</span><span>${NGN.format(m.line)}</span></div>`).join('') : '<p class="text-gray-500">Your cart is empty.</p>'; summaryTotal.textContent = NGN.format(merged.reduce((s, m) => s + m.line, 0)); }

async function init() {
  const [productsRes, meRes] = await Promise.all([fetch('/api/products'), fetch('/api/auth/me').catch(() => null)]);
  products = (await productsRes.json()).data || [];
  const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  ['name', 'email', 'phone', 'address', 'notes'].forEach((k) => { if (prefs[k]) form.elements[k].value = prefs[k]; });
  if (meRes) { const user = (await meRes.json()).data; if (user) { form.elements.name.value = user.name || form.elements.name.value; form.elements.email.value = user.email || form.elements.email.value; } }
  renderSummary();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault(); errorBox.textContent = ''; if (!cart.length) return (errorBox.textContent = 'Cart is empty.');
  const fd = new FormData(form); const method = fd.get('checkoutMethod');
  const customer = { name: `${fd.get('name') || ''}`.trim(), email: `${fd.get('email') || ''}`.trim(), phone: `${fd.get('phone') || ''}`.trim(), address: `${fd.get('address') || ''}`.trim(), notes: `${fd.get('notes') || ''}`.trim() };
  if (!customer.name || !customer.email) return (errorBox.textContent = 'Please provide your name and email.');
  if (document.getElementById('save-info').checked) localStorage.setItem(PREFS_KEY, JSON.stringify(customer));

  const endpoint = method === 'card' ? '/api/checkout/initialize' : '/api/orders/whatsapp';
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer, items: cart }) });
  const data = await res.json(); if (!res.ok) return (errorBox.textContent = data.error || 'Checkout failed');

  if (method === 'card') {
    if (!data?.data?.authorization_url) return (errorBox.textContent = 'Card checkout is not configured yet.');
    localStorage.removeItem(CART_KEY); window.location.href = data.data.authorization_url; return;
  }

  const order = data.data; const lines = ['Hello Vicbest Store, I want to complete this order:', `Order Ref: ${order.reference}`, '', ...order.items.map((m, i) => `${i + 1}. ${m.productName} x ${m.quantity} - ${NGN.format(m.lineTotal)}`), '', `Total: ${NGN.format(Number(order.amount || 0))}`, '', `Name: ${customer.name}`, `Email: ${customer.email}`, `Phone: ${customer.phone || '-'}`, `Address: ${customer.address || '-'}`, `Notes: ${customer.notes || '-'}`];
  localStorage.removeItem(CART_KEY); window.location.href = `https://wa.me/${STORE_WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
});

init();