(async function () {
  const reference = decodeURIComponent(window.location.pathname.split('/').pop() || '');
  const statusEl = document.getElementById('tracking-status');
  const box = document.getElementById('tracking-box');
  if (!reference) {
    statusEl.textContent = 'Missing order reference.';
    return;
  }

  try {
    const res = await fetch(`/api/orders/track/${encodeURIComponent(reference)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Order not found');

    document.getElementById('t-ref').textContent = data.data.payment_reference;
    document.getElementById('t-status').textContent = data.data.status;
    document.getElementById('t-total').textContent = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(Number(data.data.grandTotal || data.data.amount || 0));
    document.getElementById('t-location').textContent = data.data.delivery_zone_name || data.data.delivery_zone_code || '-';
    document.getElementById('t-items').innerHTML = (data.data.items || []).map((item) => `<li>${item.quantity} × ${item.product_name}</li>`).join('') || '<li>No items found</li>';

    statusEl.textContent = 'Order found.';
    box.classList.remove('hidden');
  } catch (err) {
    statusEl.textContent = err.message;
  }
})();