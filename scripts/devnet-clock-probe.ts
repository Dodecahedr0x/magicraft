// Prints a World's chain-clock anchor next to the ER's Clock sysvar once per second (the
// devnet TimeAnchor issue in docs/notes/deploy.md):
//   SMOKE_ENTRY=devnet-clock-probe.ts WORLD=<world pubkey> [N=8] [SMOKE_ER_RPC=...] node scripts/run-smoke.mjs
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { decodeWorld, worldChainMs } from "../app/src/chain/layout";

const er = new Connection(process.env.SMOKE_ER_RPC ?? "https://devnet-eu.magicblock.app", "confirmed");
const world = new PublicKey(process.env.WORLD!);
for (let i = 0; i < Number(process.env.N ?? 8); i++) {
  const [info, slot, clk] = await Promise.all([
    er.getAccountInfo(world),
    er.getSlot("processed"),
    er.getAccountInfo(SYSVAR_CLOCK_PUBKEY),
  ]);
  const w = decodeWorld(info!.data);
  const unixTs = Number(Buffer.from(clk!.data).readBigInt64LE(32));
  const est = worldChainMs(w, slot);
  console.log(
    JSON.stringify({
      slot,
      unixTs,
      dayTicks: w.dayTicks,
      timeOfDayMs: w.timeOfDayMs,
      clock: w.clock,
      estMinusValidatorWallMs: est === null ? null : est - (unixTs * 1000 + 500),
    }),
  );
  await new Promise((r) => setTimeout(r, 1000));
}
