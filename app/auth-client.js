/**
 * Browser auth for the sign-up page, on Neon's Managed Better Auth client.
 *
 * The page is static, so every call here goes straight to the branch's hosted
 * auth server. `__PULSE_AUTH_URL__` is replaced with that URL when the bundle is
 * built (index-service/src/app/auth-bundle.ts).
 *
 * Each call resolves to `{ ok: true, ... }` or `{ ok: false, message }` instead
 * of throwing, so the form has one shape to handle and no error is swallowed.
 */
import { createAuthClient } from '@neon/auth';

const client = createAuthClient(__PULSE_AUTH_URL__);

const UNREACHABLE = 'Could not reach the auth server. Check your connection and try again.';
const NO_ACCOUNT = 'The account was not created. Try again.';
const UNEXPLAINED = 'That did not work. Try again.';

/** Better Auth codes worth wording for a person; anything else shows its own message. */
const CODE_MESSAGES = {
  USER_ALREADY_EXISTS: 'That email already has an account. Sign in instead.',
  EMAIL_ALREADY_EXISTS: 'That email already has an account. Sign in instead.',
  INVALID_EMAIL: 'Enter an email address with an @ and a domain.',
  INVALID_EMAIL_OR_PASSWORD: 'That email and password do not match.',
  INVALID_PASSWORD: 'That email and password do not match.',
  PASSWORD_TOO_SHORT: 'Use at least 8 characters.',
};

function describeFailure(error) {
  if (typeof error?.code === 'string' && CODE_MESSAGES[error.code] !== undefined) {
    return CODE_MESSAGES[error.code];
  }
  if (typeof error?.message === 'string' && error.message.trim() !== '') {
    return error.message;
  }
  return UNEXPLAINED;
}

/**
 * Runs one client call, giving a thrown response the same shape as a returned
 * failure. Only a rejected fetch means the server was unreachable: Better Auth
 * throws its API error object on a 4xx, and that carries a code to read.
 */
async function run(request, onSuccess) {
  let result;
  try {
    result = await request();
  } catch (error) {
    if (error instanceof TypeError) return { ok: false, message: UNREACHABLE };
    return { ok: false, message: describeFailure(error) };
  }
  if (result?.error) {
    return { ok: false, message: describeFailure(result.error) };
  }
  return onSuccess(result?.data);
}

export function signUpWithEmail({ email, password, name }) {
  return run(
    () => client.signUp.email({ email, password, name }),
    (data) => (data?.user ? { ok: true, user: data.user } : { ok: false, message: NO_ACCOUNT }),
  );
}

export function signInWithEmail({ email, password }) {
  return run(
    () => client.signIn.email({ email, password }),
    (data) => (data?.user ? { ok: true, user: data.user } : { ok: false, message: NO_ACCOUNT }),
  );
}

/**
 * Hands the browser to Google, then back to this page. On success the page
 * navigates away, so the resolved value is only an error.
 */
export function signInWithGoogle() {
  return run(
    () => client.signIn.social({ provider: 'google', callbackURL: window.location.href }),
    () => ({ ok: true }),
  );
}

export function getCurrentUser() {
  return run(
    () => client.getSession(),
    (data) => (data?.user ? { ok: true, user: data.user } : { ok: true, user: null }),
  );
}

export function signOut() {
  return run(
    () => client.signOut(),
    () => ({ ok: true }),
  );
}
