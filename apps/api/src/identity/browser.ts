import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)!.content;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const status = document.getElementById('status')!;
async function post(path: string, body: object) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Larynx-CSRF': meta('larynx-csrf') }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!response.ok) throw new Error(response.status === 429 ? 'Please wait a few minutes and try again.' : 'Unable to continue. Check your code, or try signing in or recovering your account.');
  return response.json();
}
async function action(work: () => Promise<void>) {
  const buttons = document.querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(button => { button.disabled = true; });
  status.textContent = 'Working…';
  try { await work(); } catch (error) { status.textContent = error instanceof Error && error.name !== 'NotAllowedError' ? error.message : 'Passkey request cancelled. You can try again.'; }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
let recovery = false;
document.getElementById('email')!.addEventListener('submit', event => {
  event.preventDefault(); void action(async () => {
    recovery = field('purpose').value === 'recover';
    if (recovery && !field('recovery-confirm').checked) throw new Error('Please confirm that you understand account recovery.');
    await post('/account/email', { email: field('email-address').value, purpose: recovery ? 'recover' : 'register', confirmRecovery: field('recovery-confirm').checked, returnTo: meta('larynx-return') });
    document.getElementById('verify')!.hidden = false;
    status.textContent = 'Check your email for a verification code. If a code does not arrive, wait a few minutes before trying again.';
    field('verification-code').focus();
  });
});
document.getElementById('verify')!.addEventListener('submit', event => {
  event.preventDefault(); void action(async () => {
    const pending = await post('/account/register/options', { code: field('verification-code').value.trim(), deviceName: field('device-name').value, confirmRecovery: recovery && field('recovery-confirm').checked });
    const response = await startRegistration({ optionsJSON: pending.options });
    const result = await post('/account/register/finish', { id: pending.id, response });
    location.assign(result.returnTo);
  });
});
document.getElementById('signin')!.addEventListener('click', () => { void action(async () => {
  const pending = await post('/account/login/options', { returnTo: meta('larynx-return'), newDevice: field('new-device').checked });
  const response = await startAuthentication({ optionsJSON: pending.options });
  const result = await post('/account/login/finish', { id: pending.id, response });
  location.assign(result.returnTo);
}); });
