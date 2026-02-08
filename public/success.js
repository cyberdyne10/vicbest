const params = new URLSearchParams(window.location.search);
const reference = params.get('reference');

const statusText = document.getElementById('status-text');
const orderBox = document.getElementById('order-box');

async function load() {
  if (!reference) {
    statusText.textContent = 'No payment reference found.';
    return;
  }

  try {
    await fetch(`/api/paystack/verify/${reference}`);
    const orderRes = await fetch(`/api/orders/${reference}`);
    const orderData = await orderRes.json();
    if (!orderRes.ok) throw new Error('Order not found');

    document.getElementById('ref').textContent = orderData.data.payment_reference;
    document.getElementById('status').textContent = orderData.data.status;
    document.getElementById('amount').textContent = new Intl.NumberFormat('en-NG').format(orderData.data.amount);

    statusText.textContent = orderData.data.status === 'paid'
      ? 'Payment successful. Your order has been confirmed.'
      : 'Payment pending. We are still checking confirmation.';

    orderBox.classList.remove('hidden');
    if (orderData.data.status === 'paid') {
      localStorage.removeItem('vicbest_cart');
    }
  } catch (err) {
    statusText.textContent = 'Could not verify payment automatically. Please contact support with your reference.';
  }
}

load();