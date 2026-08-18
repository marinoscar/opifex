import { test as base, Page } from '@playwright/test';
import { loginAsAdmin, loginAsContributor, loginAsViewer } from '../helpers/auth.helper';

/**
 * Extended test fixtures with pre-authenticated pages.
 */
export const test = base.extend<{
  adminPage: Page;
  contributorPage: Page;
  viewerPage: Page;
}>({
  adminPage: async ({ page }, use) => {
    await loginAsAdmin(page);
    await use(page);
  },

  contributorPage: async ({ page }, use) => {
    await loginAsContributor(page);
    await use(page);
  },

  viewerPage: async ({ page }, use) => {
    await loginAsViewer(page);
    await use(page);
  },
});

export { expect } from '@playwright/test';
