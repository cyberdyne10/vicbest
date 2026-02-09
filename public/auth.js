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
  const hosts = [
    document.getElementById('auth-nav'),
    document.getElementById('auth-nav-mobile'),
  ].filter(Boolean);

  if (!hosts.length) return;

  const user = await getCurrentUser();

  if (!user) {
    hosts.forEach((host) => {
      const isMobile = host.id === 'auth-nav-mobile';
      host.innerHTML = isMobile
        ? `
          <a href="/login" class="block">Login</a>
          <a href="/signup" class="block bg-blue-900 text-white px-3 py-2 rounded-lg text-center">Sign up</a>
        `
        : `
          <a href="/login" class="hover:text-blue-800">Login</a>
          <a href="/signup" class="bg-blue-900 text-white px-3 py-1.5 rounded-lg">Sign up</a>
        `;
    });
    return;
  }

  hosts.forEach((host) => {
    const isMobile = host.id === 'auth-nav-mobile';
    host.innerHTML = isMobile
      ? `
        <span class="text-gray-700">Hi, <strong>${user.name}</strong></span>
        <a href="/checkout" class="block">My Checkout</a>
        <button class="logout-user-btn text-red-600 text-left">Logout</button>
      `
      : `
        <span class="text-gray-700">Hi, <strong>${user.name}</strong></span>
        <a href="/checkout" class="hover:text-blue-800">My Checkout</a>
        <button class="logout-user-btn text-red-600">Logout</button>
      `;
  });

  document.querySelectorAll('.logout-user-btn').forEach((btn) => {
    btn.addEventListener('click', logoutUser);
  });
}

renderAuthNav();
