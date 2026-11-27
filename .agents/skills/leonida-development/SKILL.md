---
name: leonida-development
description: Validate Leonida Unfolded viewer changes with local browser previews, Explore bookmarks, captures, and performance tests.
---

# Leonida Unfolded development

- Add `?skipExploreControls=1` to the viewer URL for automated Explore runs. Use `URL.searchParams.set("skipExploreControls", "1")` if the URL already has query parameters. The FPS benchmark supplies this flag automatically.
- The flag suppresses the automatic first-visit popup for that page load. Keep the flag off when testing onboarding. In a fresh profile, confirm that the popup opens, dismiss it, then reload and enter Explore again to check that the dismissal persists. The Controls button can reopen it.
## GPU rendering

Use the NVIDIA GPU for Explore tests, captures, and benchmarks on the hybrid Linux development host. Launch the test browser or its harness under `prime-run`. Before opening game files, create a tiny WebGL 2 context and read `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL`. On this host it should report the NVIDIA GeForce RTX 4070. If it reports the integrated GPU, a software renderer, or no identifiable renderer, stop before loading the scene and fix GPU selection. Never switch to SwiftShader, llvmpipe, or another CPU renderer. Type checks and geometry or texture decoding tests can run without a browser.

Run the FPS benchmark with the usual game-folder and output settings plus `FPS_EXPECT_GPU=NVIDIA prime-run bun run bench:fps`. `FPS_EXPECT_GPU` verifies the actual renderer, and `prime-run` selects the GPU. The benchmark rejects software WebGL even when no GPU name is specified. It creates temporary profiles under `~/.cache` by default. Set `FPS_PROFILE_ROOT` to a disk-backed directory if a different location is needed.

Use one capture browser at a time. For a rendering check, load the supplied Explore bookmark and wait for the affected geometry and materials to stream before capturing.

Keep game inputs read-only and captures local. Use a camera bookmark and a short description when the result needs to be shared.
