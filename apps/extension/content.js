// Runs on the TimePro web app origin. Forwards the logged-in session to the
// background worker so URL ingest can authenticate with the same dev-shim
// identity the web app uses. Re-reads on focus in case the user logs in/out.

const SESSION_KEY = 'tf_web_session';

function syncSession() {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) {
      chrome.runtime.sendMessage({ type: 'signout' });
      return;
    }
    const session = JSON.parse(raw);
    if (session?.organization_id && session?.user_id) {
      chrome.runtime.sendMessage({ type: 'session', session });
    }
  } catch {
    /* ignore */
  }
}

syncSession();
window.addEventListener('focus', syncSession);
