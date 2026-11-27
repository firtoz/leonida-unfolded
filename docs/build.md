# Build and decoder sources

The production build bundles the browser entry points and Web Workers, copies the two WebAssembly decoders, and emits `THIRD-PARTY-NOTICES.txt`. The corresponding source is the repository revision used to build the artifact, including `bun.lock`, the source under `src/`, the build scripts, and the decoder sources below.

- `third-party/night-decode.c` uses `third-party/bcdec.h` for block texture decoding.
- `third-party/bcpack-wasm/` contains the Rust WebAssembly wrapper and its locked dependencies. See its notices for the pinned decoder sources and table provenance.
- `public/explorer.webp` is original artwork generated for Leonida Unfolded from its own interface concept. It is distributed with the viewer.

## Raised overview water

The overview shader uses the elevation sample to distinguish low water pixels, a depth-based shoreline tint, and procedural sine ripples in world coordinates. Try the water toggle on the sample island. Native-map geometry and first-person water use their own rendering paths.

## Rebuild decoders

Use Clang with a WebAssembly linker to rebuild the block texture decoder:

```sh
clang --target=wasm32 -O3 -nostdlib -fno-builtin \
  -Wl,--no-entry -Wl,--export=input -Wl,--export=output \
  -Wl,--export=decode_night -Wl,--export=decode_bc3 -Wl,--export=decode_bc7 -Wl,--export-memory -Wl,--strip-all \
  third-party/night-decode.c -o third-party/night-decode.wasm
```

Install the `wasm32-unknown-unknown` Rust target and rebuild the BCPack decoder:

```sh
cargo build --locked --release --target wasm32-unknown-unknown \
  --manifest-path third-party/bcpack-wasm/Cargo.toml --target-dir third-party/bcpack-wasm/target
cp third-party/bcpack-wasm/target/wasm32-unknown-unknown/release/terrain_bcpack_wasm.wasm \
  third-party/bcpack-decode.wasm
```

When distributing the BCPack binary, use Rust's `--remap-path-prefix` compiler option for the checkout, Cargo cache, and Rust toolchain paths. Check the resulting binary for absolute build paths and run the decoder tests with the rebuilt binary.

The road-name layer uses the local vehicle graph and English text table. The metadata layout and lane graph fields are described in the [SixNG project notes](https://github.com/holdmysocks/SixNG).
