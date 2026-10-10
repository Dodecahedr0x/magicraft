# Magicraft

A fully onchain, browser-playable Minecraft-like survival game on Solana and
[MagicBlock](https://magicblock.gg) Ephemeral Rollups.

Every world, chunk, player position, inventory, mob and drop lives in program accounts. The game
runs on an ephemeral rollup (ER), so actions settle in milliseconds with no wallet popups during
play.

## Features

- **Worlds:** anyone can create one. The seed comes from MagicBlock VRF and terrain is generated
  onchain chunk by chunk (caves, biomes, flowing water).
- **Survival:** mining with harvest tiers and tool durability, placing, a 36-slot inventory,
  crafting, health, hunger, fall damage and a day/night cycle.
- **Mobs:** passive animals and hostile zombies, driven by MagicBlock cranks.
- **Multiplayer:** see the other players in a world, PvP with knockback, and an onchain player
  count.
- **Drops:** broken blocks drop ground items that sit in the chunk account until someone picks
  them up or they despawn.
- **Self-funding players:** a player is a delegated account holding SOL that pays rent for
  everything it creates. Withdrawing is never blocked, and unedited chunks can be closed for a
  refund.

## Repository layout

| Path | What |
|---|---|
| `programs/magicraft` | Anchor program (instructions in `src/instructions/`, account layouts in `src/state.rs`) |
| `crates/core` | Shared game logic: worldgen, physics, mobs, ground items. Used by the program and the client |
| `crates/core-wasm` | `core` compiled to wasm for the browser (output committed in `app/src/wasm/pkg`) |
| `app` | Browser client: Vite + TypeScript + Three.js with a custom voxel renderer |
| `tests` | Program test suite (ts-mocha) against a local base + ER + VRF stack |
| `scripts` | Local stack, test runner, release build, devnet smoke test |
| `bench/cu` | Compute-unit benchmarks |
| `docs` | Design, implementation plan, deploy notes, toolchain versions |

## Playing

You need a Solana wallet that supports the Wallet Standard, set to devnet, with some devnet SOL.
Connect it, fund your player, then create or join a world. You can pick the ER region
(Europe / US / Asia) in the top bar.

## Development

Requirements: Node 25 and pnpm 10.

```bash
pnpm install
```

Run the client against devnet (config in `app/.env.devnet`):

```bash
pnpm dev:devnet
```

Run the client against a local stack:

```bash
pnpm dev
```

The program IDL and the core wasm are committed, so working on the client needs no Rust
toolchain. See `app/.env.example` for every client setting.

### Program and tests

The program needs Anchor 1.0.1, the Agave Solana CLI and the MagicBlock local validators
(`npm i -g @magicblock-labs/ephemeral-validator`). Exact versions are in
[docs/notes/versions.md](docs/notes/versions.md).

Build, start the local stack, run the whole suite and tear the stack down:

```bash
pnpm test
```

Client unit tests:

```bash
pnpm -C app test
```

Core crate tests:

```bash
cargo test -p magicraft-core
```

After changing the program, copy the new IDL into the client with `pnpm -C app sync-idl`. After
changing `crates/core`, rebuild the wasm with `pnpm -C app build:wasm`.

## Deployment

- **Program:** use `pnpm build:release` for devnet or mainnet. It checks the build uses the
  production VRF queue and contains no debug instructions. The current devnet program is
  `4y2JKsSfShA6tL5K9Vk3NZPPev1bq29AqqNK9iYF9euz`. Full procedure in
  [docs/notes/deploy.md](docs/notes/deploy.md).
- **Client:** a static site built with `pnpm -C app build --mode devnet` (output in `app/dist`).
  [render.yaml](render.yaml) deploys it to Render.

## Docs

- [Design](docs/plans/2026-10-09-magicraft-design.md): accounts, rent, chain time and
  gameplay rules
- [Implementation plan](docs/plans/2026-10-09-magicraft-implementation.md)
- [Deploy notes](docs/notes/deploy.md)
- [Spikes](docs/notes/spikes.md) and [versions](docs/notes/versions.md)

## License

ISC
