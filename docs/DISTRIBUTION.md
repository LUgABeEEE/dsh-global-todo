# Where this plugin is listed

**npm is the only install source.** Every registry below is a discovery surface: it decides whether
someone finds the plugin, not what they get when they install it. The line that matters is

```sh
dsh plugin add dsh-global-todo
```

A registry that shows an older version is normal — their crawlers run on their own schedule. Last
verified **2026-10-21 11:27 (+08:00)**; in a checkout, re-check with `node tools/listings.mjs` instead
of trusting this table.

## Live

| Registry | Form | What it gives you | Verified state |
|---|---|---|---|
| **npm** | the package | the install path | `dsh-global-todo@0.13.1` |
| **1024 Store** ([deepseek1024.com](https://deepseek1024.com)) · [repo](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) | catalog entry, merged [#654](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/654) | searchable, has a public API | 🟡 entry live, but its install line still resolves to `github:LUgABeEEE/dsh-global-todo` — their npm enrichment has not caught up. Install works either way. |
| **dsh.pub** · [page](https://dsh.pub/en/plugins/dsh-global-todo/) | published page + `dshpub` CLI | `npx dshpub add LUgABeEEE/dsh-global-todo` | ✅ page live, pinned to a commit |
| **DSH-Plugins-Marketplace** ([bradeGithub](https://github.com/bradeGithub/DSH-Plugins-Marketplace)) | `registry.json`, collected from the `dsh-plugin` topic | one-click install inside DSH | ✅ `v0.13.x`, risk tier `safe` |
| **awesome-dsh-plugin** ([19.7k★](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)) | one YAML per plugin | the largest directory | ✅ merged [#7498](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7498) |
| **walkinglabs/awesome-deepseek-harness-plugins** | README entry (source-verified list) | review-backed listing | ✅ merged [#114](https://github.com/walkinglabs/awesome-deepseek-harness-plugins/pull/114) |

## Pending review

Open PRs, all made by hand against each repository's own format:

| Registry | Pull request | Note |
|---|---|---|
| Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins | [#93](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins/pull/93) | 574★, curated bilingually |
| kejixiaoliang/awesome-dsh-plugins | [#144](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/144) | merges in monthly batches; first-time contributor CI needs the maintainer |
| beancookie/awesome-dsh-plugin | [#233](https://github.com/beancookie/awesome-dsh-plugin/pull/233) | same batch pattern |
| dshworks/awesome-dsh-plugins | [#174](https://github.com/dshworks/awesome-dsh-plugins/pull/174) | machine-readable registry; this PR is a re-verification |
| losebird/dsh-plugin-market | [#49](https://github.com/losebird/dsh-plugin-market/pull/49) | replaces a broken auto entry (`github:…#v0.6.6`, manual install) with an npm spec |
| polang233/dsh-plugin-index (dshopen.org) | [issue #16](https://github.com/polang233/dsh-plugin-index/issues/16) | no PR channel; maintainer replied "will be included in the next commit" |

## Collected automatically

These scan the GitHub topic `dsh-plugin` (this repository carries it, plus `dsh`,
`deepseek-harness`, `cordis`, `todo-list`, `task-management`, `agent-tools`). No PR exists or is
needed; appearance depends on their scan cycle, and we have **not** verified each one:

`0xsline/awesome-deepseek-harness` · `vvlife/awesome-deepseek-harness-plugins` ·
`ZASENJC/dsh-plugins-store` · `YELEBAI/dsh-plugin-marketplace` ·
`awesome-dsh-plugin/dsh-find-plugin`

## How to keep this honest

```sh
node tools/listings.mjs
```

It asks npm, the 1024 API, dsh.pub, the marketplace registry, and two repository files, each with a
25-second timeout, and prints a status per registry. A fetch that cannot answer is reported as
`error`, never as "listed" — an unknown state should look unknown.

## What we deliberately do not do

- **No duplicate PRs.** If a PR is open, it gets a comment with the current version, not a second
  submission.
- **No PR to auto-collected lists.** A topic-tagged repository flows in by itself; a PR there is
  noise for the maintainer.
- **No claims about a listing before it is visible.** "Pending" means a pull request exists, not
  that the entry does.
