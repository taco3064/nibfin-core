# Developing the Nibfin Docs website

Apply this guidance when Deliver changes the public Docs website under
`website/`. Keep the approved Issue's content, scope and delivery checks.

## Design and content

- Start with what the reader needs to understand or do on the page. Put the
  answer or next action near the top. Use cards for entry points, steps for a
  sequence, tabs for equivalent commands and a diagram for relationships when
  those structures help readers. Keep headings, labels and links purposeful.
- Use the existing Starlight navigation and typography, Tailwind utilities and
  shared shadcn/ui components. Reuse an existing component for the same
  behavior. Use the Nibfin light and dark tokens for surfaces, text, focus and
  subtle borders. [Shoal](https://taco3064.github.io/shoal-app/) is a reference
  for varying the rhythm of a page according to its content.
- Preserve routes, headings and fragments used by other pages. Keep commands
  and availability claims grounded in maintained source and update the
  documentation evidence inventory when an audited page changes.

## Review, fix and recheck

- When Chrome or Chromium is available in the assigned environment, inspect
  the actual candidate preview. Capture comparable before and after views for
  changed pages on desktop and at a narrow mobile width. For a shared layout
  change, inspect every affected route. Check both themes where relevant.
- Look for clipped text, wrapped buttons, unreadable code or diagrams,
  off-screen controls, low contrast and lost keyboard focus. Check the open
  state of modified tabs, accordions and menus. Fix issues found in the
  candidate and repeat the same view or interaction.
- In the handoff, identify the revision, routes, viewport and theme actually
  reviewed, what changed after inspection, and any unverified views. Include
  screenshots when a supported evidence channel is available. If Chrome or a
  candidate preview is unavailable, report that gap and use feasible targeted
  checks.

Use targeted documentation and source checks during Deliver. GitHub-hosted CI
and Pages CD own the full Astro build, applicable browser checks and deployment
verification. Use their matching revision results as authoritative evidence
and avoid rerunning their suites on the self-hosted Runner.
