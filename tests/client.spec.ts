import { expect, test } from '@playwright/test';

test('universal shell boots without runtime errors or horizontal overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Good things start with a conversation.' })).toBeVisible();
  await expect(page.getByText('Early development', { exact: true })).toBeVisible();
  await expect(page.getByText('Your account is ready to set up. Conversations and shared plans are coming next.')).toBeVisible();
  // Browser dimensions must update the server-rendered compact layout after hydration.
  await expect(page.getByRole('heading', { name: 'Good things start with a conversation.' }))
    .toHaveCSS('font-size', page.viewportSize()!.width >= 820 ? '58px' : '42px');
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveTitle('Larynx — Your people, together');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('web navigation remains responsive with encoded and malformed callback-style queries', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const queries = [
    '?code=a%2Bb%2Fc&state=opaque%2525&scope=openid&scope=events&name=Jos%C3%A9+%F0%9F%98%80',
    `?state=${'%EA'.repeat(1024)}&code=valid%2Bcode`,
  ];
  for (const query of queries) {
    await page.goto(`/${query}`);
    await expect(page.getByRole('heading', { name: 'Good things start with a conversation.' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    // Hydration installs Router's URL handling. Reload exercises the same URL again.
    await page.reload();
    await expect(page).toHaveTitle('Larynx — Your people, together');
    expect(await page.evaluate(() => new URL(location.href).searchParams.get('code')))
      .toBe(query === queries[0] ? 'a+b/c' : 'valid+code');
  }
  expect(errors).toEqual([]);
});
