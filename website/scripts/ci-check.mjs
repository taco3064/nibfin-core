// The existing native verify job reaches this through the root entry.
if (process.env.NIBFIN_WEBSITE_PROPAGATION_CHILD === '1') {
  throw new Error('Nested verification unexpectedly passed website:check');
}
await import('./verify-failure.mjs');
await import('./negative-check.mjs');
await import('./preview-check.mjs');

await import('./theme-controls.mjs');
if (process.env.CI === 'true') await import('./theme-browser.mjs');
else console.log('Rendered browser checks Unverified locally; required on native CI.');
