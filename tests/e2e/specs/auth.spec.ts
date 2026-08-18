import { test, expect } from '@playwright/test';
import { loginAsTestUser, loginAsAdmin, isLoggedIn } from '../helpers/auth.helper';

test.describe('Test Authentication', () => {
  test('test login page is accessible in development', async ({ page }) => {
    await page.goto('/testing/login');

    // Verify page elements
    await expect(page.locator('text=Test Login - Development Only')).toBeVisible();
    await expect(page.locator('[data-testid="test-email-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="test-role-select"]')).toBeVisible();
    await expect(page.locator('[data-testid="test-login-button"]')).toBeVisible();
  });

  test('can login as viewer (default role)', async ({ page }) => {
    await loginAsTestUser(page, { email: 'viewer-test@test.local' });

    // Should be redirected to home page
    await expect(page).toHaveURL('/');

    // Should be logged in
    expect(await isLoggedIn(page)).toBe(true);
  });

  test('can login as admin', async ({ page }) => {
    await loginAsAdmin(page, 'admin-test@test.local');

    // Should be redirected to home page
    await expect(page).toHaveURL('/');

    // Should be logged in
    expect(await isLoggedIn(page)).toBe(true);
  });

  test('can access admin pages as admin', async ({ page }) => {
    await loginAsAdmin(page, 'admin-access-test@test.local');

    // Navigate to admin page
    await page.goto('/admin/users');

    // Should be able to access admin page
    await expect(page).toHaveURL('/admin/users');
  });
});
