import { normalizeLocale, translate } from '@larynx/i18n';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)!.content;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const locale = normalizeLocale(meta('larynx-locale'));
const t = (key: string) => translate(locale,`server.browser.${key}`);
class DisplayError extends Error {}
const status = document.getElementById('status')!;
async function post(path: string, body: object) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Larynx-CSRF': meta('larynx-csrf') }, body: JSON.stringify({...body,locale,explicitLocale:meta('larynx-explicit-locale') === 'true'}), credentials: 'same-origin' });
  if (!response.ok) throw new DisplayError(t(response.status === 429 ? 'rateLimit' : 'failure'));
  return response.json();
}
async function action(work: () => Promise<void>) {
  const buttons = document.querySelectorAll<HTMLButtonElement>('button'); buttons.forEach(button => { button.disabled = true; });
  status.textContent = t('working');
  try { await work(); } catch (error) { status.textContent = error instanceof DisplayError ? error.message : t(error instanceof Error && error.name === 'NotAllowedError' ? 'cancelled' : 'failure'); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
let recovery = false;
field('purpose').addEventListener('change', () => {
  const recovering = field('purpose').value === 'recover';
  document.getElementById('recovery-note')!.hidden = !recovering;
  document.getElementById('recovery-ack')!.hidden = !recovering;
  field('recovery-confirm').checked = false;
});
document.getElementById('email')!.addEventListener('submit', event => {
  event.preventDefault(); void action(async () => {
    recovery = field('purpose').value === 'recover';
    if (recovery && !field('recovery-confirm').checked) throw new DisplayError(t('recoveryAck'));
    await post('/account/email', { email: field('email-address').value, purpose: recovery ? 'recover' : 'register', confirmRecovery: field('recovery-confirm').checked, returnTo: meta('larynx-return') });
    document.getElementById('verify')!.hidden = false;
    status.textContent = t('sent');
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
