// ER region selection: the persisted choice (per base cluster) and where a delegated Player
// lives relative to the selected region. Worlds, chunks and PlayerStates are ephemeral
// accounts that exist only on the ER they were created on, and the Player PDA is delegated
// to exactly one ER validator: a Player can only play in the region it is delegated to.
import type { PublicKey } from "@solana/web3.js";
import type { ClusterConfig, Region } from "./config";
import type { KeyValueStore } from "./session";

const regionKey = (cfg: Pick<ClusterConfig, "baseRpc">) => `magicraft.region.${cfg.baseRpc}`;

/** The stored region id if it is still one of `cfg.regions`, else null (never throws). */
export function loadRegionChoice(store: KeyValueStore | null, cfg: Pick<ClusterConfig, "baseRpc" | "regions">): string | null {
  try {
    const id = store?.getItem(regionKey(cfg)) ?? null;
    return id && cfg.regions.some((r) => r.id === id) ? id : null;
  } catch {
    return null;
  }
}

/** Persists the selected region; false if storage is unavailable. */
export function saveRegionChoice(store: KeyValueStore | null, cfg: Pick<ClusterConfig, "baseRpc" | "region">): boolean {
  if (!store) return false;
  try {
    store.setItem(regionKey(cfg), cfg.region);
    return true;
  } catch {
    return false;
  }
}

/** Where the Player is relative to the selected region:
 *  - `here`: delegated to the selected region's validator (or no validator could be read:
 *    keep the pre-region behaviour and trust the selected ER);
 *  - `elsewhere`: delegated to another validator; `region` is the configured region running
 *    it (null: a validator none of the regions runs). */
export type PlayerPlacement =
  | { kind: "here" }
  | { kind: "elsewhere"; validator: PublicKey; region: Region | null };

export function playerPlacement(cfg: Pick<ClusterConfig, "erValidator" | "regions">, validator: PublicKey | null): PlayerPlacement {
  if (!validator || validator.equals(cfg.erValidator)) return { kind: "here" };
  return { kind: "elsewhere", validator, region: cfg.regions.find((r) => r.validator.equals(validator)) ?? null };
}
