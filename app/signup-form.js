/**
 * Sign-up form behaviour.
 *
 * There is no sign-up server yet, so the form validates in the browser and then
 * says plainly that nothing was sent. It never reports a success it did not get.
 */

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setMethod(method) {
  for (const button of document.querySelectorAll('.method')) {
    button.setAttribute('aria-pressed', String(button.dataset.method === method));
  }
  const fields = document.getElementById('emailFields');
  const note = document.getElementById('methodNote');
  const submit = document.getElementById('submitButton');
  const notice = document.getElementById('formNotice');
  if (!fields || !note || !submit) return;

  fields.hidden = method !== 'email';
  note.hidden = method === 'email';
  submit.textContent = method === 'email' ? 'Create account' : 'Continue with Google';
  if (notice) notice.hidden = true;
}

function showFieldError(inputId, errorId, message) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
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
  const notice = document.getElementById('formNotice');
  if (!notice) return;
  notice.textContent = text;
  notice.hidden = false;
}

/** Returns true when the form is valid, and focuses the first field that is not. */
function validateForm() {
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  if (!email || !password) return false;

  let firstInvalid = null;
  if (!EMAIL_SHAPE.test(email.value.trim())) {
    showFieldError('email', 'emailError', 'Enter an email address with an @ and a domain.');
    firstInvalid = email;
  }
  if (password.value.length < MIN_PASSWORD_LENGTH) {
    showFieldError(
      'password',
      'passwordError',
      `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
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
  const input = document.getElementById('email');
  if (!input || typed === null || typed.trim() === '') return;
  input.value = typed.trim();
}

function wireReveal() {
  const button = document.getElementById('revealPassword');
  const input = document.getElementById('password');
  if (!button || !input) return;
  button.addEventListener('click', () => {
    const revealed = input.type === 'text';
    input.type = revealed ? 'password' : 'text';
    button.setAttribute('aria-pressed', String(!revealed));
    button.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
  });
}

function wireMethodPicker() {
  for (const button of document.querySelectorAll('.method')) {
    button.addEventListener('click', () => setMethod(button.dataset.method));
  }
}

function wireForm() {
  const form = document.getElementById('signupForm');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const method = document.querySelector('.method[aria-pressed="true"]')?.dataset.method;
    clearFieldErrors();

    if (method !== 'email') {
      showNotice('Google sign-in is not connected on this build. Nothing was sent.');
      return;
    }
    if (!validateForm()) return;

    showNotice(
      'Sign-up is not wired to a server yet, so nothing was sent. ' +
        'The index and the markets are readable without an account.',
    );
  });

  // Blur is late enough not to nag while someone is still typing an address.
  document.getElementById('email')?.addEventListener('blur', (event) => {
    const input = event.target;
    if (input.value.trim() === '') return;
    if (EMAIL_SHAPE.test(input.value.trim())) return;
    showFieldError('email', 'emailError', 'Enter an email address with an @ and a domain.');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  wireMethodPicker();
  wireReveal();
  wireForm();
  prefillEmail();
});
