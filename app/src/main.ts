// App entry. Task 22 scaffold: wires the chain layer and shows cluster status; the UI,
// renderer and controller arrive in Tasks 23–27.
import { Keypair } from "@solana/web3.js";
import {
  createSessionIx,
  loadConfig,
  makeConnections,
  makeProgram,
  onboardingIxs,
  playerPda,
  topUpIx,
} from "./chain";

const status = document.getElementById("status")!;
const show = (lines: string[]) => (status.textContent = lines.join("\n"));

async function main() {
  const cfg = loadConfig(import.meta.env);
  const conns = makeConnections(cfg);
  const program = makeProgram(cfg, conns.er);
  const lines = [
    `program   ${cfg.programId.toBase58()}`,
    `base      ${cfg.baseRpc}`,
    `er        ${cfg.erRpc}`,
    `validator ${cfg.erValidator.toBase58()}`,
    `vrf queue ${cfg.vrfQueue.toBase58()}`,
  ];
  show(lines);

  // Exercise the browser polyfills (Buffer in web3.js / Anchor / the MagicBlock SDK).
  const wallet = Keypair.generate().publicKey;
  const ixs = [
    ...(await onboardingIxs(program, cfg, wallet, 1_000_000)),
    createSessionIx({ programId: cfg.programId, signer: Keypair.generate().publicKey, authority: wallet, validUntil: 0 }),
    topUpIx(wallet, playerPda(cfg.programId, wallet), 1_000_000),
  ];
  (globalThis as { __magicraftSmoke?: unknown }).__magicraftSmoke = { ok: true, ixs: ixs.length };
  lines.push(`chain layer ok (${ixs.length} ixs built)`);
  show(lines);

  const [baseSlot, erSlot] = await Promise.allSettled([conns.base.getSlot(), conns.er.getSlot()]);
  const fmt = (r: PromiseSettledResult<number>) =>
    r.status === "fulfilled" ? `slot ${r.value}` : `unreachable (${String(r.reason).slice(0, 80)})`;
  lines.push(`base: ${fmt(baseSlot)}`, `er:   ${fmt(erSlot)}`);
  show(lines);
}

main().catch((e) => {
  (globalThis as { __magicraftSmoke?: unknown }).__magicraftSmoke = { ok: false, error: String(e) };
  show([`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`]);
});
