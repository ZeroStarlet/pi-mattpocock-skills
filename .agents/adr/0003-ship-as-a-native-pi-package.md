# Ship the promoted skill set as a native PI package

PI supports Agent Skills directly and can load skills and extensions from git packages. This repository already stores valid `SKILL.md` files, but its bucketed layout includes promoted, beta, miscellaneous, and deprecated skills under one `skills/` root. PI's convention-based package discovery would expose all of them, which is not the product boundary used by the Claude Code plugin.

Several promoted skills also use two harness capabilities that PI does not provide under the same names by default:

- Cross-skill instructions say to call the `Skill` tool.
- Review, research, and architecture flows ask for isolated or parallel subagents.

PI has native `/skill:<name>` commands and supports extension tools, so both gaps can be bridged without duplicating skill content.

## Decision

- Declare the repository as a PI package in `package.json`.
- Point `pi.skills` at only `skills/engineering` and `skills/productivity`, preserving the promoted-only boundary.
- Ship `extensions/pi-compat.ts` with the package. It provides:
  - A `skill` tool, displayed as `Skill`, that loads model-invoked skills and refuses user-invoked skills.
  - A `subagent` tool that runs isolated PI subprocesses, including a parallel mode.
  - Slash-command aliases such as `/setup-matt-pocock-skills`, while PI's native `/skill:setup-matt-pocock-skills` form remains available.
- Do not add a project `.pi/settings.json` that loads this repository as a local package. A user may run PI from a checkout after installing the git package globally; self-loading would then register both copies and make the `skill` and `subagent` tools collide.
- Keep `skills.sh` as the editable-copy route. The PI package is the managed, read-only route for PI users.

## Invariants

- `package.json` must carry the `pi-package` keyword.
- `package.json`'s `pi.skills` roots must remain exactly the promoted buckets.
- `package.json`'s `pi.extensions` must include the PI compatibility extension.
- `npm run check-pi-package` must pass after adding, removing, or moving a promoted skill.
- Project PI settings must not load this repository itself. Maintainers can install the checkout as a local PI package when testing, but that is user-level state, not committed project state.
- Installing both the native PI package and an editable skills.sh copy creates duplicate skills, so users should pick one route.
