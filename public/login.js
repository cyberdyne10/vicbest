const form = document.getElementById('login-form');
const errorBox = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.textContent = '';

  const fd = new FormData(form);
  const payload = {
    email: fd.get('email'),
    password: fd.get('password'),
  };

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    errorBox.textContent = data.error || 'Login failed';
    return;
  }

  window.location.href = '/';
});