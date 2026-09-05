# Name decision: Radsvinn

**Date:** 2026-09-05 · **Status:** selected under owner-delegated naming authority
**Previous name:** Mercury · **Canonical name:** Radsvinn · **Slug:** `radsvinn`

## Decision

Name the product for **counsel that can be checked**, not for autonomous execution.
Radsvinn is a deliberate ASCII brand adaptation of Old Norse *ráð-svinnr*, a
word for being wise in counsel; it is not presented as an exact scholarly
transliteration or an invented deity. Suggested English pronunciation: **RAD-svin**.
The historical dictionary cross-references `ráðspakr` and `ráðsnjallr` for this
meaning.[7][9]

The implemented product turns a request into a dependency-aware plan, grounds it
against repository evidence, validates it deterministically, and requires human
approval before the separate tracker writer acts. Agents advise; code checks;
humans authorize. That is a closer relationship than the previous messenger
metaphor. The name also survives additional trackers, agent runtimes, and scoped
project context without claiming these roadmap capabilities are already built.

## Naming evidence and trade-off

The first-party review records a naming convention: Norse themes for personal
projects and Matrix themes for company projects. This is a documented preference,
not an inference from repository ownership, and not a universal prohibition on
other names. Role-based metaphors, compact standalone names, and shell-friendly
spellings are compatible patterns. Radsvinn follows the personal-project
convention and fits the product's advisory role. Detailed private-repository
findings remain outside public documentation.

Radsvinn is less familiar than a major mythological character, but has one stable
ASCII spelling, two suggested spoken syllables, and no AI suffix or invented
compound. The spelling is a modest discovery cost accepted in exchange for a
specific meaning and considerably less developer-tool confusion.

| Candidate | Assessment |
| --- | --- |
| **Radsvinn** | Strong counsel/plan relationship; selected. |
| Forseti | Strong judgment metaphor, but established Google-origin cloud-security project and npm collision.[5][11] |
| Andvari | Attractive compact name, but less specific to planning and existing Node/Go projects and npm package.[10] |
| Orlog | Constraints/destiny fit, but an existing AI product is a direct collision.[1] |
| Skirnir | Readable messenger metaphor, but existing software and too close to the role being retired.[3][4] |

## Collision findings (point-in-time, not legal clearance)

Checks on 2026-09-05 found no GitHub repository-name search results for `radsvinn`
and no repository at `0merUfuk/radsvinn` before this migration. The GitHub user
handle `radsvinn` is already taken; this does not prevent the owner-qualified
repository. Exact npm names `radsvinn`, `radsvinn-dashboard`, and
`radsvinn-harness`, the owner-qualified Go proxy module, and Homebrew core/cask
lookups returned HTTP 404. These are lookup results, not reservations or future
availability guarantees. No Homebrew formula or public npm release existed for
this project, so this rename does not invent either distribution channel.

An entertainment reference, “Radsvinn's Rig,” is an acknowledged search collision;
no major developer-tool collision was found in the bounded search.[12]
No formal trademark clearance or reliable domain-registration check was performed.
A domain is not a prerequisite and no domain was purchased.

## Migration policy

- Canonical branding, module/repository links, package metadata, image examples,
  new environment settings and agent context use Radsvinn / `radsvinn` / `RADSVINN_`.
- Existing `MERCURY_` environment settings remain explicit compatibility aliases.
  Canonical settings take precedence, including explicitly empty values; invalid
  canonical values must not silently fall back to legacy values.
- Both old and new credential names remain excluded from model-child environments
  and redacted where appropriate. Renaming must not weaken a security boundary.
- Persisted plans, audit records, cookies/signatures, external headers and tracker
  provenance retain compatibility where identity changes would lose state,
  bypass duplicate protection, or disrupt mixed-version clients.
- Historical commits, release tags and release assets are not rewritten. The
  historical v0.1.0 release remains evidence of the earlier product identity.
- `treecheck` remains the descriptive gate executable: it was never named Mercury.
  No unnecessary CLI alias, package publication, or data rewrite is introduced.
- Alias removal requires a documented breaking-release migration with legacy-use
  evidence; this rename alone does not authorize removal.

The implementation's migration guide and reference audit document exact retained
contracts. This decision is **YELLOW**: ordinary code changes are reversible,
while repository URLs and configuration migration carry coordination costs.

## Sources

[1] https://orlogai.com
[3] https://github.com/Hyldem0er/Skirnir
[4] https://github.com/altenwald/skirnir
[5] https://opensource.google/projects/forsetisecurity
[7] https://cleasby-vigfusson-dictionary.vercel.app/word/rad-svinnr
[9] http://germanic-lexicon-project.org/html/oi_cleasbyvigfusson/b0487.html
[10] https://github.com/benoneal/andvari
[11] https://github.com/forseti-security/forseti-security
[12] https://godofwar.fandom.com/wiki/Radsvinn%27s_Rig
