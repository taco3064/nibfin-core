// The existing native verify job reaches this through the root entry.
if (process.env.NIBFIN_WEBSITE_PROPAGATION_CHILD === '1') {
  throw new Error('Nested verification unexpectedly passed website:check');
}
await import('./verify-failure.mjs');
await import('./negative-check.mjs');
await import('./preview-check.mjs');
