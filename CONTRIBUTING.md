# Contributing

## Report a bug or request compatibility

Include the viewer version or commit, browser version, operating system, and game build. Describe the steps, expected result, and observed result. For a map issue, include a camera bookmark if it helps reproduce the view. For a compatibility request, give the version and describe what happened when you selected your own authorized local files.

Use a short text error with personal paths, usernames, tokens, and private URLs removed. A camera bookmark, a text description, or a reproduction using the sample island is enough to start a report.

## What belongs in the project

These guidelines cover documentation, source, fixtures, commit messages and diffs, issues, pull requests, comments, attachments, releases, and the project site.

| Include | Keep private |
| --- | --- |
| Original viewer code, diagrams, and explanations. Ordinary format notes can describe file and archive structure, geometry, rendering, and decals in your own words. | Copied game code, disassembly or decompiler output, proprietary shader source or bytecode, and private research notes. |
| Original synthetic fixtures, sample-island captures, and independently licensed material with source and license recorded. | Game executables and archives, extracted meshes or textures, generated game indexes or profiles, game screenshots and clips, and links to copies or downloads. |
| Supported build identifiers, camera bookmarks, sanitized errors, and aggregate measurements with their test conditions. | Keys, cipher inputs, raw private diagnostics, personal paths, and credentials. |

Bring proposed changes to protected archive access or public documentation of its internals to the maintainer for review before sharing the details. Start with a description of the viewer behavior and the files it needs. The project uses local, read-only access to user-selected files.

## Submit a patch

Record the origin and license of any reused code or fixture. Check that its terms permit redistribution here, including any attribution requirements. When origin or permission is unclear, leave the material out and describe the gap in the PR.

Run `bun run check`, `bun test`, and `bun run build` for code changes. In the PR, summarize what changed, what you verified, and any gaps. Before committing or sharing, review the actual diff, new files, commit messages, and any attachments or links. For a Pages or release change, review the packaged output too.

If restricted material is already in a submission, flag the location to the maintainer without quoting it or reposting the link. Maintainers should remove exposed material where their controls allow and ask for a sanitized replacement. Material in Git history or published artifacts needs separate maintainer review.
