import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { formatDate, translate } from '@larynx/i18n';

const fr = (key: string, values?: Record<string, unknown>) => translate('fr', key, values);
const inbox = `http://127.0.0.1:${process.env.MAILPIT_HTTP_PORT ?? '8025'}`;
test.use({ locale: 'fr-CA' });

async function frenchMail(request: APIRequestContext, email: string, subjectKey: string, bodyKey: string) {
  let id: string | undefined;
  await expect.poll(async () => {
    const list = await (await request.get(`${inbox}/api/v1/messages`)).json();
    id = list.messages.find((message: { ID: string; Subject: string; To: { Address: string }[] }) =>
      message.Subject === fr(subjectKey) && message.To.some(to => to.Address === email))?.ID;
    return Boolean(id);
  }).toBe(true);
  const message = await (await request.get(`${inbox}/api/v1/message/${id}`)).json();
  expect(message.Text).toContain(fr(bodyKey));
  const code = (message.Text as string).split(/\r?\n/).map(line => line.trim()).find(line => /^[A-Za-z0-9_-]{43}$/.test(line));
  expect(code).toBeTruthy();
  return code!;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('detects regional French, persists an explicit language choice and falls back for unsupported languages', async ({ page, browser }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('button', { name: 'Français', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: fr('client.home.heading'), exact: true })).toBeVisible();
  await noOverflow(page);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Good things start with a conversation.', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('larynx.locale'))).toBe('en');
  // A localized invitation link overrides a saved choice, without encoding credentials.
  await page.goto('/?lang=fr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  expect(await page.evaluate(() => localStorage.getItem('larynx.locale'))).toBe('fr');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('french-home.png'), fullPage: true });
  const unsupported = await browser.newContext({ locale: 'de-DE', baseURL: testInfo.project.use.baseURL ?? 'http://127.0.0.1:8088' });
  try {
    const other = await unsupported.newPage();
    await other.goto('/');
    await expect(other.getByRole('heading', { name: 'Good things start with a conversation.', exact: true })).toBeVisible();
    await expect(other.locator('html')).toHaveAttribute('lang', 'en');
    for (const query of ['?lang=de', '?lang=fr&lang=en', '?lang=%ZZ']) {
      await other.goto(`/${query}`);
      await expect(other.getByRole('heading', { name: 'Good things start with a conversation.', exact: true })).toBeVisible();
      await expect(other.locator('html')).toHaveAttribute('lang', 'en');
    }
  } finally { await unsupported.close(); }
  expect(errors).toEqual([]);
});

test('French signup, consent, audience, invitation emails and recovery preserve the account language', async ({ page, context, request }, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const email = `francais-${randomUUID()}@larynx.test`;
  await page.goto('/account');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.getByRole('button', { name: fr('client.account.signIn'), exact: true }).click();
  await expect(page).toHaveURL(/localhost:\d+\/account\/login/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('heading', { name: 'Vos proches, réunis.', exact: true })).toBeVisible();
  await page.getByLabel(fr('server.login.email'), { exact: true }).fill(email);
  await page.getByRole('button', { name: fr('server.login.send'), exact: true }).click();
  await page.getByLabel(fr('server.login.code'), { exact: true }).fill(await frenchMail(request, email, 'server.mail.registerSubject', 'server.mail.registerIntro'));
  await page.getByLabel(fr('server.login.device'), { exact: true }).fill('Téléphone de Zoë');
  await noOverflow(page);
  await page.getByRole('button', { name: fr('server.login.verify'), exact: true }).click();
  await page.getByRole('button', { name: fr('server.oauth.continue'), exact: true }).click();
  await expect(page.getByRole('heading', { name: fr('server.oauth.consentHeading'), exact: true })).toBeVisible();
  await expect(page.getByText(fr('server.scope.profile:read'), { exact: false })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('french-consent.png'), fullPage: true });
  const accountResponse = page.waitForResponse(response => response.url().endsWith('/v1/account') && response.request().method() === 'GET');
  await page.getByRole('button', { name: fr('server.oauth.allow'), exact: true }).click();
  const account = await (await accountResponse).json();
  await expect(page.getByRole('heading', { name: fr('client.account.signedIn'), exact: true })).toBeVisible();
  expect(account.locale).toBe('fr');
  await expect(page.getByText(new RegExp(formatDate('fr', account.devices[0].createdAt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible();
  // Changing language while signed in must reach the authenticated preference endpoint.
  for (const [name, locale] of [['English', 'en'], ['Français', 'fr']]) {
    const saved = page.waitForResponse(response => response.url().endsWith('/v1/account/locale') && response.request().method() === 'POST');
    await page.getByRole('button', { name, exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
  }
  await page.getByRole('link', { name: fr('client.common.socialLink'), exact: true }).click();
  await page.getByRole('button', { name: fr('client.social.createCircle'), exact: true }).click();
  await expect(page.getByText(fr('client.social.circleCreated'), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: fr('client.social.newConversation'), exact: true }).click();
  await page.getByRole('button', { name: fr('client.social.preview'), exact: true }).click();
  await expect(page.getByText(fr('client.social.inclusionSources', { count: 1, number: '1' }), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: fr('client.social.circle'), exact: true }).click();
  await page.getByRole('button', { name: /^Utiliser le cercle / }).click();
  await page.getByRole('button', { name: fr('client.social.addSource'), exact: true }).click();
  await page.getByRole('button', { name: fr('client.social.preview'), exact: true }).click();
  await expect(page.getByText(fr('client.social.inclusionSources', { count: 2, number: '2' }), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: fr('client.social.createConversation'), exact: true }).click();
  await expect(page.getByText(fr('client.social.encryptionDescription'), { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('french-audience.png'), fullPage: true });
  await page.getByRole('link', { name: fr('client.common.invitationsLink'), exact: true }).click();
  await page.getByRole('button', { name: /^(?:✓ )?Cercle [a-f0-9]{6}$/ }).click();
  await page.getByLabel(fr('client.invitations.recipient'), { exact: true }).fill(email);
  await page.getByRole('button', { name: fr('client.invitations.send'), exact: true }).click();
  const token = await frenchMail(request, email, 'server.mail.invitationSubject', 'server.mail.invitationInstructions');
  await page.getByLabel(fr('client.invitations.emailLabel'), { exact: true }).fill(email);
  await page.getByLabel(fr('client.invitations.code'), { exact: true }).fill(token);
  await page.getByRole('button', { name: fr('client.invitations.requestVerification'), exact: true }).click();
  await page.getByLabel(fr('client.invitations.verificationLabel'), { exact: true }).fill(await frenchMail(request, email, 'server.mail.proofSubject', 'server.mail.proofIntro'));
  await page.getByRole('checkbox', { name: fr('client.invitations.confirmLabel'), exact: true }).click();
  await page.getByRole('button', { name: fr('client.common.acceptInvitation'), exact: true }).click();
  await expect(page.getByLabel(fr('client.invitations.code'), { exact: true })).toHaveValue('');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('french-invitations.png'), fullPage: true });
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: ['larynx.locale'], session: [] });

  await page.getByRole('link', { name: fr('client.common.backAccount'), exact: true }).click();
  await page.getByRole('button', { name: fr('client.account.signOut'), exact: true }).click();
  await page.getByRole('button', { name: fr('client.account.signIn'), exact: true }).click();
  await page.getByLabel(fr('server.login.email'), { exact: true }).fill(email);
  await page.getByLabel(fr('server.login.purpose'), { exact: true }).selectOption('recover');
  await expect(page.getByText(fr('server.login.recoveryNote'), { exact: true })).toBeVisible();
  await page.getByLabel(fr('server.login.recoveryAck'), { exact: true }).check();
  await page.getByRole('button', { name: fr('server.login.send'), exact: true }).click();
  await page.getByLabel(fr('server.login.code'), { exact: true }).fill(await frenchMail(request, email, 'server.mail.recoverSubject', 'server.mail.recoveryWarning'));
  await page.getByLabel(fr('server.login.device'), { exact: true }).fill('Appareil récupéré');
  await page.getByRole('button', { name: fr('server.login.verify'), exact: true }).click();
  const continueAuthorization = page.getByRole('button', { name: fr('server.oauth.continue'), exact: true });
  const allowAuthorization = page.getByRole('button', { name: fr('server.oauth.allow'), exact: true });
  // Recovery may retain the issuer login and proceed directly to fresh consent.
  await expect(continueAuthorization.or(allowAuthorization)).toBeVisible();
  if (await continueAuthorization.isVisible()) await continueAuthorization.click();
  await allowAuthorization.click();
  await expect(page.getByText(fr('client.account.recoveryComplete'), { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await noOverflow(page);
  expect(errors).toEqual([]);
});
