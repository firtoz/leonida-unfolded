# Legal notice

## Project scope

Leonida Unfolded is an independent browser viewer for exploring and studying the GTA VI map. Rockstar Games and Take-Two Interactive own their respective game content and trademarks. The project is unaffiliated with them. The viewer's [GPL-3.0-only license](LICENSE) applies to the viewer code and grants no rights over game content.

Use the supported files from your own lawfully obtained copy and only where you are authorized to use them with the viewer. The browser reads the selected files locally, leaves them unchanged, and draws the world with the viewer's own renderer. The repository and site distribute the viewer code and its own sample content. The viewer can keep derived data in a browser-local cache. The optional local index tools write derived indexes for local reuse. Keep those indexes and original game files private. The sample island uses original content and runs without game files.

## What the archive directory does

An RPF9 table of contents acts as a directory. The viewer uses it to locate the resources needed for the current view and read the relevant ranges efficiently. For resources that are already readable independently of the protected directory, using that directory speeds up lookup of the same resource data. Players can also see much of the same world in ordinary play. The intended use is independent visualization of that local world for exploration and study.

The current viewer opens protected RPF9 directories, and some features also read protected archive members. The lookup argument applies to resources that are independently readable. For other resources, the access question depends on what the measure protects, what routes to the same content are available, and what the applicable law and terms permit.

In the United States, 17 U.S.C. § 1201 addresses measures that effectively control access to a copyrighted work. Whether the same work is otherwise readily accessible matters to that analysis. The statute also sets conditions for interoperability work and for sharing the means used to do it. This section describes the viewer's purpose and the basis for the lookup argument. [17 U.S.C. § 1201](https://uscode.house.gov/us/usc/119-134/t17/s1201/) · [Lexmark v. Static Control](https://www.opn.ca6.uscourts.gov/opinions.pdf/04a0364p-06.pdf)

## Reporting a concern

Use the repository's issue tracker to contact the maintainer about a specific feature, source file, or release artifact. Describe the concern without attaching proprietary files, keys, or private research. See the [contribution guidelines](CONTRIBUTING.md) for what to include.
