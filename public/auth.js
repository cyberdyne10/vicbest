async function getCurrentUser() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    return data.data || null;
  } catch {
    return null;
  }
}

async function logoutUser() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}

async function renderAuthNav() {
  const host = document.getElementById('auth-nav');
  if (!host) return;

  const user = await getCurrentUser();
  if (!user) {
    host.innerHTML = `
      <a href="/login" class="hover:text-blue-800">Login</a>
      <a href="/signup" class="bg-blue-900 text-white px-3 py-1.5 rounded-lg">Sign up</a>
    `;
    return;
  }

  host.innerHTML = `
    <span class="text-gray-700">Hi, <strong>${user.name}</strong></span>
    <a href="/checkout" class="hover:text-blue-800">My Checkout</a>
    <button id="logout-user-btn" class="text-red-600">Logout</button>
  `;

  const logoutBtn = document.getElementById('logout-user-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', logoutUser);
}

renderAuthNav();