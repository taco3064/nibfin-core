// Validate against Astro's actual build output, never a second route manifest.
export function checkNavigation(sidebar, pages) {
  const routes = new Set(
    pages.map(({ pathname }) => pathname.replace(/^\/+|\/+$/g, '')),
  );
  function visit(items) {
    for (const item of items) {
      if (typeof item === 'string') {
        checkSlug(item);
      } else if ('slug' in item) {
        checkSlug(item.slug);
      } else if ('items' in item) {
        visit(item.items);
      } else if ('link' in item && item.link.startsWith('/')) {
        throw new Error('Use a Starlight content slug for internal navigation.');
      }
    }
  }
  function checkSlug(slug) {
    const route = slug.replace(/(^|\/)index$/, '').replace(/\/$/, '');
    if (!routes.has(route)) {
      throw new Error(`Navigation target has no generated documentation route: ${slug}`);
    }
  }
  visit(sidebar);
}
