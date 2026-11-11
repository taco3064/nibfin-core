# Documentation workspace

This workspace reuses the Core Node `24.22.1` and npm `11.9.0` baseline. Use the
root lockfile; do not initialize another repository or install a separate lockfile.
Website scripts invoke the installed Astro CLI through Node so disposable source
copies do not depend on executable JavaScript shims. Astro and its native tools
still require the assigned environment's ordinary installation permissions.

From the repository root:

```sh
npm ci --ignore-scripts
npm run website:check
npm run website:build
npm run website:preview -- --host 127.0.0.1 --port 4321
```

`website:check` first compares the [public source checklist](evidence/README.md),
then runs theme validation, Astro's TypeScript diagnostics and a static build
(which validates Starlight frontmatter and generated navigation). `website:build`
only builds. Root `npm run verify` retains Core checks/tests and runs the website
check and production build first, then Core checks and tests selected for the changed paths.
The existing read-only CI verify job installs the npm
workspace with the root lockfile and runs that same entry.

The required native `verify` job installs the pinned Chromium browser and runs
the root entry. Its final `website:ci` stage runs
`npm run website:verify-failure`, which introduces a disposable TypeScript
error and a documentation audit failure in a disposable source copy. Both must fail
root verification at the affected source, using explicit changed paths without a Git index.
It removes the copy on completion, then executes the controls also exposed as
`npm run website:negative` and `npm run website:preview-check`, then theme controls
and native rendered browser checks.
The preview check builds both bases,
inspects generated paths, all article links/fragments and assets, starts the documented preview command,
checks actual HTTP index/404/CSS/JavaScript/search responses in CI, and stops preview.
Outside CI it performs both static inspections and leaves HTTP Unverified.
`node website/scripts/preview-check.mjs --static` selects static checks.
Startup, request and cleanup failures fail CI. Run these commands from the root.
The HTTP runner targets native Linux CI, with bounded startup/request timeouts.

Restricted Deliver and Accept environments may lack preview networking or browser
downloads. Report unavailable checks Unverified; native CI must run them on the
exact final PR head. See THEME.md for the rendered test matrix.

Edit English Markdown/MDX in `website/src/content/docs/`. Every document needs a
`title` in frontmatter. Starlight owns routing and search; `src/content.config.ts`
uses its loader/schema. `index.md` maps to the selected base index;
`guides/start.md` maps to `<base>guides/start/`. Configure the sidebar in
`website/navigation.mjs` using content slugs such as `index` or `guides/start`.
Astro generates `.astro/` metadata and `dist/` static
output inside `website/`; neither belongs in commits. Pagefind search output is
created by Starlight during production builds.

## Local repository Pages paths

`WEBSITE_SITE` is an HTTP(S) origin, default `https://taco3064.github.io`.
`WEBSITE_BASE` is the public path prefix, default `/nibfin-core/`. The origin is
not the repository path. These defaults describe future Pages configuration,
not an existing deployed URL or a custom domain. Base paths must start and end
with `/`; segments may contain letters, numbers, `_` and `-`.

```sh
WEBSITE_SITE=https://example.org WEBSITE_BASE=/other-docs/ npm run website:build
WEBSITE_SITE=https://example.org WEBSITE_BASE=/other-docs/ \
  npm run website:preview -- --host 127.0.0.1 --port 4321
curl -i http://127.0.0.1:4321/other-docs/
curl -i http://127.0.0.1:4321/other-docs/does-not-exist/
```

Repeat without the environment overrides for `/nibfin-core/`. The index must
return 200 and the missing route 404, without a successful index fallback.
Inspect HTML and referenced local stylesheet/script and search assets under each
base, including `dist/pagefind/`, for missing files or duplicated base segments.
These are local HTTP checks, not browser E2E or live Pages verification.

## Negative controls

Use a disposable copy of the source and installed dependencies. Separately:

`npm run website:negative` automates these controls in a temporary
workspace under the system temporary directory, requiring the valid and restored sources to pass.
It needs the root dependencies installed and removes its copy on completion.

- Add `website/src/bad.ts` containing `const bad: number = "wrong";`.
- Remove the required `title` from the index frontmatter.
- Change the `index` slug in `website/navigation.mjs` to `does-not-exist`.

Run `npm run website:check` after each mutation; each must fail nonzero with a
relevant error. Restore each mutation and check again. The navigation build hook
compares configured slugs with Astro's actual generated pages. Use Starlight
`slug` items for internal navigation so Starlight handles base prefixes.

The [shared theme interface](THEME.md) provides tokens for DOC03 and DOC04.
DOC05 and DOC06 can add content without
reinitializing Core. DOC08 owns published-site browser testing; local
theme checks are documented in THEME.md. Public documents
must describe verified availability and must not contain private source,
credentials or protected operational details. Documentation projects product
requirements; it does not create another requirements or control authority.

## GitHub Pages

Core CD checks for website changes after successful push CI on `main`. For
production, an administrator must set Pages Source to GitHub Actions and
configure the `github-pages` environment to allow deployments from `main` under
the repository's approval policy. The build reads the origin and base from
Pages and checks both the alternate path and production output before uploading
`website/dist`. Only the deploy job can publish that run's artifact.

To retry from `main` or deploy after enabling Pages, use the same Core CD
workflow with `deploy_docs=true`. Read back the run and tested source, Pages
artifact, environment approval where applicable, deployment status and
`page_url`. A successful build alone establishes only the build result.

## Onboarding content

The index and sidebar expose Getting Started, installation, CLI and Runner guides.
Public component read-back is unavailable in the isolated authoring environment,
so executable onboarding commands and formal release claims are withheld.
`node website/scripts/docs-check.mjs` compares available source/help without
onboarding mutations. Source and generated-link positive/negative controls run
with the existing root tests. The maintained onboarding browser tests inspect
keyboard navigation and the actual candidate help example in both themes and
desktop/mobile views, under both bases via `npm run website:browser`.
