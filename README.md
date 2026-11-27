# Leonida Unfolded

Explore GTA VI’s Leonida in 3D using your own game files. Start with the map, use **Explore here** to explore on foot or in free flight, and copy a camera bookmark to revisit the same view.

Choose **Try the sample island** on the viewer’s opening page. The demo generates its own terrain and needs no game files.

## Game files and affiliation

Leonida Unfolded is an independent, read-only browser tool for exploring and studying game maps. Use supported Xbox Series files from your own lawfully obtained copy of GTA VI that you are authorized to use with the viewer. Your browser reads the selected files locally and leaves them unchanged. The viewer renders the scene independently and never runs the game.

The release contains no Rockstar game files or keys. Leonida Unfolded is unaffiliated with Rockstar Games and Take-Two Interactive. See the [legal notice](LEGAL.md) for how the viewer uses archive directories and local data.

## Open a game folder

1. In a desktop browser with WebGL 2, choose **Choose game folder** and select the Xbox Series v1.0.2.1 folder. All game views require the matching `game_scarlett_master.exe` and archives. The viewer lists required and optional files on its opening screen.
2. Use the Pause map to choose an area. Enable the layers you want from **Layers**.
3. To explore at street level, select **Explore here**. Use WASD to move and drag to look around.
4. Press **Esc** or choose **Map** to see your position and heading. Zoom or pan the map, then press **Esc** again or choose **Resume** to continue.
5. Use **Copy view** to share the camera position and orientation. The recipient supplies their own supported local files.

Open **Sidebar → Customize** to show starting points, coordinate entry, tile inspection, or saved-index controls. Enable **Places** for the Roadside tunnel and Selkie Hole cave shortcuts. The viewer remembers these preferences in your browser.

Enable **Road names** in **Layers** to label roads as you zoom in and show the nearest named road while exploring. This layer uses your local `data.rpf` and displays the available English names.

If a supported version fails, open an issue with the game version, viewer version, browser version, reproduction steps, and sanitized error. If you have a different lawfully obtained version, you can request compatibility. Leave game files, keys and download links out of reports.

## Run locally

You need Bun to work from source. CI uses Bun 1.4.4. [Install Bun](https://bun.com/docs/installation)

From the repository root, install dependencies and start the Vite development server.

```sh
bun install --frozen-lockfile
bun run dev
```

Open the URL printed by Vite. For a production build or to rehearse the GitHub Pages deployment, run:

```sh
bun run check
bun test
bun run build
bun run preview
```

The browser build is in `dist/`. Its license, third-party notices, and source links ship with the viewer. See [build notes](docs/build.md) for decoder sources and release attribution.

The viewer code is licensed under [GPL-3.0-only](LICENSE). The bundled dependencies retain their own licenses.

## Contributing

Read the [contribution guidelines](CONTRIBUTING.md) before opening an issue or submitting a patch. They cover what can go into documentation, commits, reports, and pull requests.

See the [performance and fidelity TODO](TODO.md) for investigations you can assign independently. Use [Resource Queue](https://github.com/firtoz/resource-queue) to coordinate benchmark runs from multiple agents on one machine.

Maintained by [firtoz](https://github.com/firtoz).
