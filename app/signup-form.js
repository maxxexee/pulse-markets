/**
 * Sign-up form behaviour, backed by the branch's hosted Neon Auth server.
 *
 * The page only reports what the server returned: a created account, an error
 * code, or a session it could read back. Nothing is shown as done that is not.
 */
import {
  getCurrentUser,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  signUpWithEmail,
} from './auth-client.bundle.js?v=dda257706d';

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Where a signed-in reader belongs. Both auth paths end here. */
const DASHBOARD_URL = './dashboard/';

/** Which call the email form makes. A returning reader needs a way back in. */
let mode = 'signup';

function byId(id) {
  return document.getElementById(id);
}

function showEmailForm() {
  const options = byId('options');
  const block = byId('emailBlock');
  if (!options || !block) return;
  options.hidden = true;
  block.hidden = false;
  hideNotice();
  refreshSubmitLabel();
  byId('email')?.focus();
}

function showOptions() {
  const options = byId('options');
  const block = byId('emailBlock');
  if (!options || !block) return;
  options.hidden = false;
  block.hidden = true;
  clearFieldErrors();
  hideNotice();
}

function refreshSubmitLabel() {
  const submit = byId('submitButton');
  if (submit) submit.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
}

function showFieldError(inputId, errorId, message) {
  const input = byId(inputId);
  const error = byId(errorId);
  if (!input || !error) return;
  input.setAttribute('aria-invalid', 'true');
  error.textContent = message;
  error.hidden = false;
}

function clearFieldErrors() {
  for (const error of document.querySelectorAll('.error')) {
    error.textContent = '';
    error.hidden = true;
  }
  for (const input of document.querySelectorAll('[aria-invalid]')) {
    input.removeAttribute('aria-invalid');
  }
}

function showNotice(text) {
  const notice = byId('formNotice');
  if (!notice) return;
  notice.textContent = text;
  notice.hidden = false;
}

function hideNotice() {
  const notice = byId('formNotice');
  if (!notice) return;
  notice.textContent = '';
  notice.hidden = true;
}

/** Returns true when the form is valid, and focuses the first field that is not. */
function validateForm() {
  const email = byId('email');
  const password = byId('password');
  if (!email || !password) return false;

  let firstInvalid = null;
  if (!EMAIL_SHAPE.test(email.value.trim())) {
    showFieldError('email', 'emailError', 'Enter an email address with an @ and a domain.');
    firstInvalid = email;
  }
  if (password.value.length < MIN_PASSWORD_LENGTH) {
    showFieldError('password', 'passwordError', `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    firstInvalid = firstInvalid ?? password;
  }
  if (firstInvalid) {
    firstInvalid.focus();
    return false;
  }
  return true;
}

/** Carries an address typed on the landing page into the form. */
function prefillEmail() {
  const typed = new URLSearchParams(window.location.search).get('email');
  const input = byId('email');
  if (!input || typed === null || typed.trim() === '') return;
  input.value = typed.trim();
  showEmailForm();
}

function wireReveal() {
  const button = byId('revealPassword');
  const input = byId('password');
  if (!button || !input) return;
  button.addEventListener('click', () => {
    const revealed = input.type === 'text';
    input.type = revealed ? 'password' : 'text';
    button.setAttribute('aria-pressed', String(!revealed));
    button.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
  });
}

function wireOptions() {
  byId('googleOption')?.addEventListener('click', () => void submitGoogle());
  byId('emailOption')?.addEventListener('click', showEmailForm);
  byId('backToOptions')?.addEventListener('click', showOptions);
}

/** Blocks a second submit while one is in flight, without losing the label. */
function setBusy(busy) {
  const submit = byId('submitButton');
  if (!submit) return;
  submit.disabled = busy;
  submit.setAttribute('aria-busy', String(busy));
  for (const button of document.querySelectorAll('.option')) {
    button.disabled = busy;
  }
}

function showSignedIn(user) {
  const form = byId('signupForm');
  const intro = document.querySelector('.intro .lead');
  const session = byId('session');
  const text = byId('sessionText');
  if (!form || !session || !text) return;

  form.hidden = true;
  session.hidden = false;
  text.textContent = `Signed in as ${user.email}`;
  if (intro) intro.hidden = true;
}

function showSignedOut() {
  const form = byId('signupForm');
  const intro = document.querySelector('.intro .lead');
  const session = byId('session');
  const text = byId('sessionText');
  if (form) form.hidden = false;
  if (session) session.hidden = true;
  if (text) text.textContent = '';
  if (intro) intro.hidden = false;
}

/** Split name into the single field Better Auth stores; blank stays blank. */
function displayName() {
  const first = byId('firstName')?.value.trim() ?? '';
  const last = byId('lastName')?.value.trim() ?? '';
  return `${first} ${last}`.trim();
}

async function submitEmail() {
  if (!validateForm()) return;
  const credentials = {
    email: byId('email').value.trim(),
    password: byId('password').value,
    name: displayName(),
  };
  setBusy(true);
  const result =
    mode === 'signin'
      ? await signInWithEmail(credentials)
      : await signUpWithEmail(credentials);
  setBusy(false);
  if (!result.ok) {
    showNotice(result.message);
    return;
  }
  showSignedIn(result.user);
  window.location.assign(DASHBOARD_URL);
}

async function submitGoogle() {
  setBusy(true);
  const result = await signInWithGoogle();
  // A successful call navigates to Google, so only a failure returns here.
  setBusy(false);
  if (!result.ok) showNotice(result.message);
}

function wireForm() {
  const form = byId('signupForm');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideNotice();
    clearFieldErrors();
    await submitEmail();
  });

  // Blur is late enough not to nag while someone is still typing an address.
  byId('email')?.addEventListener('blur', (event) => {
    const input = event.target;
    if (input.value.trim() === '') return;
    if (EMAIL_SHAPE.test(input.value.trim())) return;
    showFieldError('email', 'emailError', 'Enter an email address with an @ and a domain.');
  });
}

function wireModeSwitch() {
  const link = byId('modeSwitch');
  if (!link) return;
  link.addEventListener('click', () => {
    mode = mode === 'signup' ? 'signin' : 'signup';
    link.textContent =
      mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in';
    clearFieldErrors();
    hideNotice();
    refreshSubmitLabel();
  });
}

function wireSignOut() {
  const button = byId('signOut');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    const result = await signOut();
    button.disabled = false;
    if (!result.ok) {
      showNotice(result.message);
      return;
    }
    showSignedOut();
    showNotice('Signed out.');
  });
}

/**
 * A page reload keeps the session, so the form reflects it on load. Google sends the
 * reader back to this page rather than the dashboard, so a live session forwards on.
 */
async function restoreSession() {
  const result = await getCurrentUser();
  if (!result.ok || !result.user) return;
  showSignedIn(result.user);
  window.location.assign(DASHBOARD_URL);
}

function init() {
  wireOptions();
  wireReveal();
  wireForm();
  wireModeSwitch();
  wireSignOut();
  prefillEmail();
  void restoreSession();
}

// Module scripts are deferred, so the document is parsed by the time this runs.
init();
