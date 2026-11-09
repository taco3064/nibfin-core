# Shared semantic theme

`src/styles/tokens.css` is the only maintained color-value source. Dark values
live on `:root`; Light overrides live on `:root[data-theme='light']`. Starlight
sets `data-theme` from its Light/Dark/Auto control, persists explicit preferences
and follows system changes in Auto. Keep this behavior in future consumers.

`src/styles/theme.css` loads the fonts, maps Starlight and shadcn semantics,
and includes Tailwind utilities. `tailwind.config.mjs` maps those utilities to
CSS properties, with no second palette and no Tailwind preflight reset.
Astro pages outside Starlight must import `theme.css` once in their layout.
React consumers inherit the same properties; no React package is needed here.

## Stable interface

Every name below has the `--nf-` prefix. Values are **full CSS colors**; use
`var(--nf-background)`, never `hsl(var(--nf-background))`. New consumers should
use a foreground/background pair from this table. Theme changes require rerunning
the checks, including actual rendered contrast.

| Foreground | Background | Purpose |
| --- | --- | --- |
| `text` | `background`, `surface` | Reading, navigation, cards |
| `secondary` | `background`, `surface`, `raised` | Secondary text |
| `link`, `hover` | `background`, `surface` | Links and hover emphasis |
| `on-accent` | `accent`, `hover` | Primary controls, selected navigation |
| `code` | `code-bg` | Inline and fenced code |
| `info` | `info-bg` | Informational status |
| `success` | `success-bg` | Successful status, separate from brand accent |
| `warning` | `warning-bg` | Warning status |
| `danger` | `danger-bg` | Error status |
| `focus`, `border` | `background`, `surface`, `raised` | Control indicators |

Text pairs require 4.5:1. Large text and focus/control boundaries require 3:1.
Focus outlines have an offset so they contrast against the surrounding surface.
Avoid opacity on readable text; browser checks composite paints and ancestor
opacity against the actual canvas. Code uses one readable semantic foreground;
syntax font styles remain available without a separate unchecked color palette.

Shadcn-compatible names are `--background`, `--foreground`, `--card`,
`--card-foreground`, `--popover`, `--popover-foreground`, `--primary`,
`--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`,
`--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`,
`--destructive-foreground`, `--border`, `--input` and `--ring`. They are full CSS
color aliases. Adapt shadcn consumer styles to this representation rather than
copying a default HSL palette. Destructive controls use the danger color as their
background and danger-bg as their foreground. Muted text uses secondary on raised.

Starlight's `--sl-color-*` aliases cover document, navigation, sidebar, inline
code, status and selection colors. Search uses the same source through its
`--pagefind-ui-*` properties. Expressive Code uses `--ec-*` aliases and a semantic
code foreground override for the installed version's light/dark span selectors.

## Typography and minimal consumer

DM Sans Variable supplies body text (weights 100–1000); Space Grotesk Variable
supplies headings (300–700). Normal body is 400, emphasis 600–700. Starlight owns
heading sizes. Both stacks fall back to `system-ui, sans-serif`. Code retains
Starlight's system monospace stack. The Latin WOFF2 assets are maintained under
`src/assets/fonts/`, bundled with base-aware URLs by Astro. Non-Latin text uses
the fallback stack; italics may be synthesized. No runtime font CDN is used.
Fontsource variable packages 5.3.0 supplied the upstream font files. The
redistributed SIL Open Font Licenses are in `licenses/`.

An Astro consumer can use the real utilities directly:

```astro
---
import '../styles/theme.css';
---
<section class="bg-background text-foreground border border-border">
  <button class="bg-primary text-primary-foreground focus-visible:outline-ring">
    Read documentation
  </button>
</section>
```

`src/components/ThemeConsumer.astro` demonstrates background, foreground, muted,
border, accent and focus utilities inside the production Starlight reading sample
at `<base>theme/`. The fixture includes long prose, headings, code and statuses.
It is a theme demonstration, not installation guidance or a product release.

## Verification

From the repository root, with pinned root-lockfile dependencies installed:

```sh
npm run website:theme
npm run website:check
node --test test/website-*.test.mjs
npm run website:ci
npx playwright install --with-deps chromium
npm run website:browser
npm run verify
```

`website:check` includes the theme source check before Astro diagnostics/build.
`website:theme` also runs disposable negative controls: missing token, missing
alias, alias cycle, wrong utility mapping, missing font and low-contrast text.
The restored source must pass. No maintained fixture is mutated.

`website:ci` preserves all prior diagnostics/frontmatter/navigation negative
controls, root failure propagation, two-base static checks and native HTTP checks.
It adds theme/font output inspection and token/contrast controls. In native CI it
also requires `website:browser`; outside CI it reports rendered checks Unverified.
The existing required verify job installs Chromium from pinned Playwright 1.56.1
before running `verify`. A browser failure fails the job; it is never a skip.
Git-dependent Core checks still require the native checkout's actual Git metadata.

The browser runner builds and previews each of `/nibfin-core/` and
`/alternate-docs/` in turn. For both Light and Dark it checks 1280×900 and 360×900
viewports, plus 360×900 with 200% root text size. It verifies computed mappings,
loaded fonts, rendered text contrast, hover/selected/focus states, desktop/sidebar
and mobile navigation, real Pagefind results and navigation, keyboard focus,
modal dismissal/focus return, theme persistence/Auto, and page overflow. Contrast
uses resolved text paints and ancestor backgrounds/opacity, including code tokens,
status text and search results. A rendered low-contrast mutation must fail.
Screenshots wait for fonts and disable animations; they supplement assertions.
Inspect both theme captures for the indigo/violet direction and heading hierarchy
when browser tooling is available. Captures and test copies are disposable and
are removed after the runner confirms child termination.

Restricted environments may lack browser downloads, preview networking or Git
metadata. Report those exact checks Unverified with their cause; source/static
results do not prove rendered accessibility or visual approval. Native PR-head CI
and independent review remain required. None of these checks prove live Pages
publication, which is outside this theme work.
