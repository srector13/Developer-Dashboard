import { test, expect } from './helpers';

test.describe('App shell & onboarding', () => {
  test('launches with the correct window title', async ({ launchApp }) => {
    const { page } = await launchApp();
    await expect(page).toHaveTitle('Markdown Notebook');
  });

  test('shows the onboarding overlay on a fresh profile', async ({ launchApp }) => {
    const { page } = await launchApp();
    const onboarding = page.locator('#onboarding');
    await expect(onboarding).toHaveClass(/active/);
    await expect(page.locator('.onboarding-card h2')).toHaveText('Welcome to Markdown Notebook');
    await expect(page.getByRole('button', { name: /Select Notebook Folder/i })).toBeVisible();
  });

  test('renders the core layout regions', async ({ launchApp }) => {
    const { page } = await launchApp();
    await expect(page.locator('#app-container')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#content-canvas')).toBeVisible();
    await expect(page.locator('#search-input')).toBeVisible();
  });

  test('dismisses onboarding when a notebook root is configured', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });
    await expect(page.locator('#onboarding')).not.toHaveClass(/active/);
  });
});

test.describe('Global chrome interactions', () => {
  test('toggles the global theme', async ({ launchApp }) => {
    // Seed so the onboarding overlay is not covering the theme button.
    const { page } = await launchApp({ seedNotebook: true });
    const body = page.locator('body');
    // Sidebar icon buttons have no text; the app moves their `title` into a
    // `data-tooltip` attribute (custom tooltip system), so target that.
    const themeBtn = page.locator('[data-tooltip="Toggle Light/Dark Theme"]');

    // Toggling always flips between dark and light, regardless of the initial
    // (system-derived) theme — so assert the flip rather than an absolute state.
    const startedDark = await body.evaluate((el) => el.classList.contains('dark-theme'));
    await themeBtn.click();
    await expect(body).toHaveClass(startedDark ? /light-theme/ : /dark-theme/);
    await themeBtn.click();
    await expect(body).toHaveClass(startedDark ? /dark-theme/ : /light-theme/);
  });

  test('opens and closes the command palette with the keyboard', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });
    const palette = page.locator('#command-palette-modal');

    await expect(palette).toBeHidden();
    await page.keyboard.press('ControlOrMeta+K');
    await expect(palette).toBeVisible();
    await expect(page.locator('#palette-search-input')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('opens and closes the settings modal', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });
    const modal = page.locator('#settings-modal');

    await expect(modal).not.toHaveClass(/active/);
    await page.locator('[data-tooltip="Settings"]').click();
    await expect(modal).toHaveClass(/active/);
    await expect(page.locator('#settings-modal h3')).toHaveText('Settings');

    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).not.toHaveClass(/active/);
  });
});
