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
  await expect(page.getByText('The shared app foundation is here. Accounts and messaging are still being built.')).toBeVisible();
  // Browser dimensions must update the server-rendered compact layout after hydration.
  await expect(page.getByRole('heading', { name: 'Good things start with a conversation.' }))
    .toHaveCSS('font-size', page.viewportSize()!.width >= 820 ? '58px' : '42px');
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
