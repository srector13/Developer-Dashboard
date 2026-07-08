import { test, expect } from './helpers';

test.describe('Notebook tree & navigation', () => {
  test('renders seeded sections and pages in the sidebar', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });
    const tree = page.locator('#notebook-tree');

    await expect(tree.locator('.tree-node-label', { hasText: 'Projects' })).toBeVisible();
    await expect(tree.locator('.tree-node-label', { hasText: 'Journal' })).toBeVisible();
    await expect(tree.locator('.tree-node-label', { hasText: 'Welcome' })).toBeVisible();
  });

  test('opens a note and shows its title and rendered preview', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });

    await page.locator('#notebook-tree .tree-node-label', { hasText: 'Welcome' }).click();

    await expect(page.locator('#note-workspace')).toBeVisible();
    await expect(page.locator('#note-title')).toHaveText('Welcome');
    await expect(page.locator('#note-meta-date')).toHaveText('2026-07-01');

    // The markdown body (H1 stripped by the renderer) is shown in the preview pane.
    const preview = page.locator('#preview-pane');
    await expect(preview.getByText('This is a', { exact: false })).toBeVisible();
    await expect(preview.locator('strong', { hasText: 'seeded' })).toBeVisible();
    // Task checkboxes render from the markdown checklist.
    await expect(preview.locator('input.task-checkbox')).toHaveCount(2);
  });

  test('switches between preview, edit and split view modes', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });
    await page.locator('#notebook-tree .tree-node-label', { hasText: 'Welcome' }).click();

    const container = page.locator('#editor-preview-container');
    await expect(container).toHaveClass(/preview-mode/);

    await page.locator('#btn-mode-edit').click();
    await expect(container).toHaveClass(/edit-mode/);
    await expect(page.locator('#note-editor')).toBeVisible();
    await expect(page.locator('#note-editor')).toHaveValue(/# Welcome/);

    await page.locator('#btn-mode-split').click();
    await expect(container).toHaveClass(/split-mode/);

    await page.locator('#btn-mode-preview').click();
    await expect(container).toHaveClass(/preview-mode/);
  });

  test('filters the tree via the sidebar search box', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });
    const tree = page.locator('#notebook-tree');
    // Welcome is a root-level page (always visible); Alpha lives inside a
    // collapsed section, so assert on tree membership (count) as the filter runs.
    const welcome = tree.locator('.tree-node-label', { hasText: 'Welcome' });
    const alpha = tree.locator('.tree-node-label', { hasText: 'Alpha Project' });

    await expect(welcome).toBeVisible();
    await expect(alpha).toHaveCount(1);

    await page.locator('#search-input').fill('welcome');
    // The matching root page stays; the non-matching page is dropped from the tree.
    await expect(welcome).toBeVisible();
    await expect(alpha).toHaveCount(0);

    await page.locator('#search-input').fill('');
    await expect(alpha).toHaveCount(1);
  });
});

test.describe('Dashboard & page creation', () => {
  test('opens the notebook dashboard with task metrics', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });

    await page.locator('.logo-area').click();
    await expect(page.locator('#landing-workspace')).toBeVisible();

    // Seeded notes contain 3 open tasks and 1 completed task in total.
    await expect(page.locator('#metric-pending')).toHaveText('3');
    await expect(page.locator('#metric-completed')).toHaveText('1');
  });

  test('creates a new page through the create modal', async ({ launchApp }) => {
    const { page } = await launchApp({ seedNotebook: true });

    // The sidebar "Page" button opens the create modal.
    await page.locator('.tree-controls').getByRole('button', { name: 'Page', exact: true }).click();
    const modal = page.locator('#create-modal');
    await expect(modal).toHaveClass(/active/);

    await page.locator('#create-modal-name').fill('E2E Generated Page');
    await modal.getByRole('button', { name: 'Create' }).click();

    // Creating opens the new note in the workspace.
    await expect(modal).not.toHaveClass(/active/);
    await expect(page.locator('#note-title')).toHaveText('E2E Generated Page');

    // And it appears in the sidebar tree.
    await expect(
      page.locator('#notebook-tree .tree-node-label', { hasText: 'E2E Generated Page' }),
    ).toBeVisible();
  });
});
