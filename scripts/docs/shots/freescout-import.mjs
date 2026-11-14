export const shots = [{
  name: 'imports/freescout',
  path: '/settings/import',
  run: async (page) => {
    await page.getByRole('button', { name: /FreeScout/ }).click();
    await page.getByLabel('Instance URL', { exact: true }).fill('https://support.example.com/helpdesk');
    await page.evaluate(() => { for (const img of document.images) if (!img.complete) img.remove(); });
  },
}];
