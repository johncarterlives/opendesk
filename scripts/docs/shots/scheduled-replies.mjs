export const shots = [{
  name: 'inbox/scheduled-reply',
  path: '/inbox/open',
  run: async (page) => {
    await page.getByText('SSO login loops back to sign-in page').first().click();
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.fill('Thanks Dana, the certificate is updated. Please try signing in again.');
    await page.getByRole('button', { name: 'Send', exact: true }).locator('xpath=following-sibling::*').first().click();
    await page.getByRole('menuitem', { name: 'Send later', exact: true }).click();
    await page.getByRole('button', { name: 'Schedule reply', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel schedule', exact: true }).waitFor();
    await page.evaluate(() => { for (const img of document.images) if (!img.complete) img.remove(); });
  },
}];
