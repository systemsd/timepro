// Popup: show status, toggle tracking, configure the API base, flush on demand.

const $ = (id) => document.getElementById(id);

async function render() {
  const d = await chrome.storage.local.get(['session', 'apiBase', 'enabled', 'buffer']);
  const user = $('user');
  if (d.session?.user_id) {
    user.textContent = d.session.display_name || d.session.user_id.slice(0, 8);
    user.className = 'status ok';
  } else {
    user.textContent = 'open TimePro web';
    user.className = 'status off';
  }
  $('buffered').textContent = Array.isArray(d.buffer) ? d.buffer.length : 0;
  $('enabled').checked = d.enabled !== false;
  $('apiBase').value = d.apiBase || 'http://localhost:4001';
}

$('enabled').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
});

$('save').addEventListener('click', async () => {
  const apiBase = $('apiBase').value.trim() || 'http://localhost:4001';
  await chrome.storage.local.set({ apiBase });
  $('msg').textContent = 'Saved.';
  setTimeout(() => ($('msg').textContent = ''), 1500);
});

$('flush').addEventListener('click', async () => {
  $('msg').textContent = 'Sending…';
  const res = await chrome.runtime.sendMessage({ type: 'flush' });
  $('msg').textContent = res?.ok ? `Sent ${res.sent} event(s).` : 'Send failed.';
  await render();
});

render();
