---
name: leonida-constants
description: Name and organize fixed values in Leonida Unfolded. Apply when adding or changing cache or schema versions, native format IDs or offsets, renderer modes, numerical thresholds, texture slots, or values shared with shaders.
---

# Leonida constants

Use an existing constants module for the affected subsystem. When one is missing, create a narrowly named module beside the code, such as `street-material-constants.ts` or `street-shadow-constants.ts`. Keep the value and its meaning together with a name that identifies the field, role, or units.

- Use `street-cache-versions.ts` for persisted street cache versions and compatibility IDs. When moving a version, preserve its value, generated key, and legacy lookup order. Change only the version tied to an incompatible format change.
- Put native IDs, masks, and record offsets in named bindings or layouts grouped by format. Keep unrelated values independent even when their numeric values happen to match.
- Define enums, sampler assignments, and thresholds shared by TypeScript and GLSL once. Interpolate them into shader source and preserve GLSL integer or float typing.
- Give tunable values names with units such as meters, milliseconds, or texels. Inline arithmetic identities, obvious indexes, and fixed vector components where naming them would obscure the expression.
- Before finishing a constants-only refactor, check the resulting cache keys, shader values, and compatibility branches against the old implementation. Run `bun run check`, `bun test`, and `bun run build`.
