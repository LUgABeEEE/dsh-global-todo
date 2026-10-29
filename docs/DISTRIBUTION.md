# Where this plugin is listed

**npm is the only install source.** Every registry below is a discovery surface: it decides whether
someone finds the plugin, not what they get when they install it. The line that matters is

```sh
dsh plugin add dsh-global-todo
```

A registry that shows an older version is normal — their crawlers run on their own schedule. Last
verified **2026-10-29 23:30 (+08:00)**; in a checkout, re-check with `node tools/listings.mjs` instead
of trusting this table.

## Live

| Registry | Form | What it gives you | Verified state |
|---|---|---|---|
| **npm** | the package | the install path | `dsh-global-todo@0.19.0` |
| **1024 Store** ([deepseek1024.com](https://deepseek1024.com)) · [repo](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) | catalog entry, merged [#654](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/654) | searchable, has a public API | 🟡 entry live, but its install line still resolves to `github:LUgABeEEE/dsh-global-todo` — their npm enrichment has not caught up. Install works either way. |
| **dsh.pub** · [page](https://dsh.pub/en/plugins/dsh-global-todo/) | published page + `dshpub` CLI | `npx dshpub add LUgABeEEE/dsh-global-todo` | ✅ page live, pinned to a commit |
| **DSH-Plugins-Marketplace** ([bradeGithub](https://github.com/bradeGithub/DSH-Plugins-Marketplace)) | `registry.json`, collected from the `dsh-plugin` topic | one-click install inside DSH | ✅ `v0.19.0`, risk tier `safe` |
| **awesome-dsh-plugin** ([19.7k★](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)) | one YAML per plugin | the largest directory | ✅ merged [#7498](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7498) |
| **walkinglabs/awesome-deepseek-harness-plugins** | README entry (source-verified list) | review-backed listing | ✅ merged [#114](https://github.com/walkinglabs/awesome-deepseek-harness-plugins/pull/114) |
| **dsh.works** · [site](https://dsh.works/awesome-dsh-plugins/) · [repo](https://github.com/dshworks/awesome-dsh-plugins) | machine-readable index (21,928 rows), rebuilt daily | a stable target for anything that wants plugin metadata | ✅ in the index at `0.19.0`, category `memory`; listed by sweep, not by PR (our [#178](https://github.com/dshworks/awesome-dsh-plugins/issues/178) got the index re-cut and a daily job added) |
| **dsh-xray** · [card](https://unstone.github.io/dsh-xray/p/LUgABeEEE__dsh-global-todo.html) · [repo](https://github.com/unStone/dsh-xray) | capability card with `file:line` evidence, plus a live badge | a reader can see what the plugin can do before installing | ✅ rated `C2`. It read `C3` because one `!` in `files` made the whole allowlist unmodellable, so files the tarball never ships were scored ([#7](https://github.com/unStone/dsh-xray/issues/7)); upstream replaced the heuristic with `npm-packlist` ([#9](https://github.com/unStone/dsh-xray/pull/9)) and rescanned, and our `files` no longer uses negations either. `exec_tooling` / `eval_tooling` remain as non-scoring evidence |
| **bruc3van/awesome-dsh-plugin** ([469★](https://github.com/bruc3van/awesome-dsh-plugin)) | one row in `MARKET.md` | a second large table, refreshed from the topic | ✅ row 656 |
| **dsh-plugin.shop** · [site](https://www.dsh-plugin.shop/) · [repo](https://github.com/losebird/dsh-plugin-market) | a curated JSON entry beside a topic-collected registry | a browsable market with an install line that works | ✅ merged [#49](https://github.com/losebird/dsh-plugin-market/pull/49) on 2026-10-29, install spec `dsh-global-todo` — it replaces the auto entry that pinned `github:…#v0.6.6` |
| **Blue-Whale-Harness** · [site](https://leenkcool.github.io/plugins.zh.html) | site index + `repos.txt` | a Chinese-language zone map | ✅ listed, category `tools` (closed our request with 已收录, 2026-10-25) |
| **deepseekserver.com** · [page](https://deepseekserver.com/zh/resources/dsh-global-todo) | a resources page per language | long-form entry with the README linked | ⚠️ page live, snapshot old — it still shows ⭐3 and files us under "渠道" |

## Pending review

Open PRs, all made by hand against each repository's own format:

| Registry | Pull request | Note |
|---|---|---|
| Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins | [#93](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins/pull/93) | 574★, curated bilingually |
| kejixiaoliang/awesome-dsh-plugins | [#144](https://github.com/kejixiaoliang/awesome-dsh-plugins/pull/144) | merges in monthly batches; first-time contributor CI needs the maintainer |
| beancookie/awesome-dsh-plugin | [#233](https://github.com/beancookie/awesome-dsh-plugin/pull/233) | same batch pattern |
| polang233/dsh-plugin-index (dshopen.org) | [issue #16](https://github.com/polang233/dsh-plugin-index/issues/16) | no PR channel; the maintainer said it would be included in the next commit and closed the issue — we have not seen the entry, so it stays here |

## Collected automatically

These scan the GitHub topic `dsh-plugin` (this repository carries it, plus `dsh`,
`deepseek-harness`, `cordis`, `todo-list`, `task-management`, `agent-tools`). No PR exists or is
needed; appearance depends on their scan cycle, and we have **not** verified each one:

`0xsline/awesome-deepseek-harness` · `vvlife/awesome-deepseek-harness-plugins` ·
`ZASENJC/dsh-plugins-store` · `YELEBAI/dsh-plugin-marketplace` ·
`awesome-dsh-plugin/dsh-find-plugin`

## Badges

Two registries hand out a badge an author may embed, and both are in the README under the language
switch:

```md
<!-- dsh.works: static, their snippet, needs no upkeep -->
[![listed on dsh.works](https://img.shields.io/badge/listed_on-dsh.works-00c2e9?labelColor=0d0d0d)](https://dsh.works/awesome-dsh-plugins/)

<!-- dsh-xray: live endpoint, reads their daily scan and can say something unflattering -->
[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2FLUgABeEEE__dsh-global-todo.json)](https://unstone.github.io/dsh-xray/p/LUgABeEEE__dsh-global-todo.html)
```

The others do not offer one: 1024 Store, dsh.pub, DSH-Plugins-Marketplace, bruc3van's list and
walkinglabs only publish their own repository badges. Never invent a "listed on" badge for those —
the npm version badge in the README covers the one fact a reader actually needs.

## How to keep this honest

```sh
node tools/listings.mjs
```

It asks npm, the 1024 API, dsh.pub, the marketplace registry, dsh-xray's badge, bruc3van's
`MARKET.md`, the Blue-Whale site and the deepseekserver page, each with a 25-second timeout, and
prints a status per registry. A fetch that cannot answer is reported as `error`, never as "listed" —
an unknown state should look unknown. dsh.works is hand-checked on purpose: its 12 MB index times
out from here and a timeout would read as "not listed".

## What we deliberately do not do

- **No duplicate PRs.** If a PR is open, it gets a comment with the current version, not a second
  submission.
- **No PR to auto-collected lists.** A topic-tagged repository flows in by itself; a PR there is
  noise for the maintainer.
- **No claims about a listing before it is visible.** "Pending" means a pull request exists, not
  that the entry does.
