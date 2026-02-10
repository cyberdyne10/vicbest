const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });
const CART_KEY = 'vicbest_cart'; const PREFS_KEY = 'vicbest_checkout_prefs';
const STORE_WHATSAPP_NUMBER = '2348091747685';
const summaryItems = document.getElementById('summary-items');
const summarySubtotal = document.getElementById('summary-subtotal');
const summaryDelivery = document.getElementById('summary-delivery');
const summaryTotal = document.getElementById('summary-total');
const form = document.getElementById('checkout-form'); const errorBox = document.getElementById('error');
const submitBtn = document.getElementById('submit-btn');
const locationSelect = document.getElementById('delivery-zone');
let products = []; let cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); let deliveryQuote = null;

function getMergedCart() { return cart.map((item) => { const p = products.find((x) => x.id === item.productId); return p ? { ...item, name: p.name, price: p.price, line: p.price * item.quantity } : null; }).filter(Boolean); }
function cartSubtotal() { return getMergedCart().reduce((s, m) => s + m.line, 0); }

async function refreshDeliveryQuote() {
  const subtotal = cartSubtotal();
  const deliveryZoneCode = `${locationSelect.value || ''}`.trim();
  deliveryQuote = null;
  if (!deliveryZoneCode) {
    summaryDelivery.textContent = 'Select location';
    summaryTotal.textContent = NGN.format(subtotal);
    return;
  }

  const res = await fetch('/api/delivery/calculate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveryZoneCode, cartSubtotal: subtotal })
  });
  const data = await res.json();
  if (!res.ok) {
    summaryDelivery.textContent = data.error || 'Unavailable';
    summaryTotal.textContent = NGN.format(subtotal);
    throw new Error(data.error || 'Delivery is unavailable for this location');
  }

  deliveryQuote = data.data;
  summaryDelivery.textContent = NGN.format(deliveryQuote.deliveryFee || 0);
  summaryTotal.textContent = NGN.format(deliveryQuote.grandTotal || subtotal);
}

async function renderSummary() {
  const merged = getMergedCart();
  const subtotal = merged.reduce((s, m) => s + m.line, 0);
  summaryItems.innerHTML = merged.length ? merged.map((m) => `<div class="flex justify-between"><span>${m.name} × ${m.quantity}</span><span>${NGN.format(m.line)}</span></div>`).join('') : '<p class="text-gray-500">Your cart is empty.</p>';
  summarySubtotal.textContent = NGN.format(subtotal);
  try { await refreshDeliveryQuote(); } catch (_) {}
}

async function init() {
  const [productsRes, meRes, zonesRes] = await Promise.all([fetch('/api/products'), fetch('/api/auth/me').catch(() => null), fetch('/api/delivery/zones')]);
  products = (await productsRes.json()).data || [];
  const zonesData = await zonesRes.json();
  const zones = zonesData.data || [];
  locationSelect.innerHTML = ['<option value="">Select delivery location</option>']
    .concat(zones.map((z) => `<option value="${z.code}" ${Number(z.is_covered) !== 1 ? 'disabled' : ''}>${z.name}${Number(z.is_covered) === 1 ? ` - ${NGN.format(z.flat_fee || 0)}` : ' (Outside coverage)'}</option>`))
    .join('');

  const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  ['name', 'email', 'phone', 'address', 'notes'].forEach((k) => { if (prefs[k]) form.elements[k].value = prefs[k]; });
  if (prefs.deliveryZoneCode) locationSelect.value = prefs.deliveryZoneCode;
  if (meRes) { const user = (await meRes.json()).data; if (user) { form.elements.name.value = user.name || form.elements.name.value; form.elements.email.value = user.email || form.elements.email.value; } }
  await renderSummary();
}

locationSelect.addEventListener('change', async () => {
  errorBox.textContent = '';
  try { await refreshDeliveryQuote(); } catch (err) { errorBox.textContent = err.message; }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault(); errorBox.textContent = ''; if (!cart.length) return (errorBox.textContent = 'Cart is empty.');
  const fd = new FormData(form); const method = fd.get('checkoutMethod');
  const customer = { name: `${fd.get('name') || ''}`.trim(), email: `${fd.get('email') || ''}`.trim(), phone: `${fd.get('phone') || ''}`.trim(), address: `${fd.get('address') || ''}`.trim(), notes: `${fd.get('notes') || ''}`.trim(), deliveryZoneCode: `${fd.get('deliveryZoneCode') || ''}`.trim() };
  if (!customer.name || !customer.email) return (errorBox.textContent = 'Please provide your name and email.');
  if (!customer.deliveryZoneCode) return (errorBox.textContent = 'Please select a delivery location.');

  try { await refreshDeliveryQuote(); } catch (err) { return (errorBox.textContent = err.message); }
  if (!deliveryQuote || !deliveryQuote.isCovered) return (errorBox.textContent = 'Selected delivery location is unavailable.');

  if (document.getElementById('save-info').checked) localStorage.setItem(PREFS_KEY, JSON.stringify({ ...customer }));

  const endpoint = method === 'card' ? '/api/checkout/initialize' : '/api/orders/whatsapp';

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-70', 'cursor-not-allowed');
    submitBtn.textContent = method === 'card' ? 'Processing card checkout...' : 'Connecting to WhatsApp...';
  }

  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer, items: cart }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');

    if (method === 'card') {
      if (!data?.data?.authorization_url) throw new Error('Card checkout is not configured yet.');
      localStorage.removeItem(CART_KEY);
      window.location.href = data.data.authorization_url;
      return;
    }

    const order = data.data;
    const lines = ['Hello Vicbest Store, I want to complete this order:', `Order Ref: ${order.reference}`, '', ...order.items.map((m, i) => `${i + 1}. ${m.productName} x ${m.quantity} - ${NGN.format(m.lineTotal)}`), '', `Subtotal: ${NGN.format(Number(order.subtotalAmount || 0))}`, `Delivery (${order.deliveryZoneName || customer.deliveryZoneCode}): ${NGN.format(Number(order.deliveryFee || 0))}`, `Grand Total: ${NGN.format(Number(order.grandTotal || order.amount || 0))}`, '', `Name: ${customer.name}`, `Email: ${customer.email}`, `Phone: ${customer.phone || '-'}`, `Address: ${customer.address || '-'}`, `Location: ${order.deliveryZoneName || customer.deliveryZoneCode}`, `Notes: ${customer.notes || '-'}`];
    localStorage.removeItem(CART_KEY);
    window.location.href = `https://wa.me/${STORE_WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
  } catch (err) {
    errorBox.textContent = err.message || 'Checkout failed';
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-70', 'cursor-not-allowed');
      submitBtn.textContent = 'Complete Checkout';
    }
  }
});

init();