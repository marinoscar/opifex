import { test, expect } from '../fixtures/auth.fixture';

test.describe('Admin functionality', () => {
  test('admin can access user management', async ({ adminPage }) => {
    await adminPage.goto('/admin/users');

    // Verify we're on the admin page
    await expect(adminPage).toHaveURL('/admin/users');
    await expect(adminPage.locator('h1, h2, h3, h4, h5, h6').first()).toBeVisible();
  });

  test('admin can access system settings', async ({ adminPage }) => {
    await adminPage.goto('/admin/settings');

    // Verify we're on the settings page
    await expect(adminPage).toHaveURL('/admin/settings');
  });
});

test.describe('Role-based access', () => {
  test('viewer cannot access admin users page', async ({ viewerPage }) => {
    await viewerPage.goto('/admin/users');

    // Should be redirected away from admin page
    // Either to home or access denied page
    await expect(viewerPage).not.toHaveURL('/admin/users');
  });

  test('contributor can access regular pages', async ({ contributorPage }) => {
    await contributorPage.goto('/settings');

    // Should be able to access user settings
    await expect(contributorPage).toHaveURL('/settings');
  });
});

test.describe('Home page', () => {
  test('shows content for authenticated user', async ({ viewerPage }) => {
    await viewerPage.goto('/');

    // Should be on home page
    await expect(viewerPage).toHaveURL('/');
  });
});
