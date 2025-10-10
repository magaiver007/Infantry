const form = document.getElementById('signupForm');
const msg = document.getElementById('msg');
const btn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  btn.disabled = true;

  const data = Object.fromEntries(new FormData(form));
  const { username, password } = data;
  const confirm = document.getElementById('confirm').value;
  if (password !== confirm) {
    msg.textContent = 'Οι κωδικοί δεν ταιριάζουν.';
    btn.disabled = false;
    return;
  }
  // Send roles as CSV; server will split.
  try {
    const res = await fetch('/admin/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        roles: document.getElementById('roles').value
      })
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      msg.textContent = json.message || 'Σφάλμα.';
      btn.disabled = false;
      return;
    }
    msg.style.color = '#b7f5c4';
    msg.textContent = 'Ο χρήστης δημιουργήθηκε.';
    form.reset();
  } catch {
    msg.textContent = 'Πρόβλημα σύνδεσης με τον διακομιστή.';
  } finally {
    btn.disabled = false;
  }
});