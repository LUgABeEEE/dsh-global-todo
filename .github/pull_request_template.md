# Pull request

## What this changes

<!-- One paragraph. Link the issue it closes: "Closes #12". -->

## Why

<!-- The problem, not the patch. If a design decision was involved, say which
     alternatives you rejected and why. docs/DESIGN.md may need the same note. -->

## Checklist

- [ ] `npm run verify` passes locally
- [ ] Tests cover the change (a new behaviour without a test will be asked for one)
- [ ] No dependency, bundler or build step was added
- [ ] Every mutation still goes through `lib/service.js` (one write path for the panel and the tools)
- [ ] User-facing strings exist in both `zh` and `en` (client) or follow the host-side convention
- [ ] `package.json` version and `VERSION` in `lib/index.js` still agree
- [ ] Docs updated when the surface changed: `README.md`, `README.zh.md`, `docs/DESIGN.md`

## How it was verified

<!-- Exact commands and what you saw. If you loaded it in a live host, say so and
     what you clicked. -->
