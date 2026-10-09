// Base-layer and ephemeral-rollup connections.
import { Connection } from "@solana/web3.js";
import type { ClusterConfig } from "./config";

export type Connections = {
  /** Base layer: Player onboarding, top-ups, session tokens, `withdraw_base`. */
  base: Connection;
  /** Ephemeral rollup: all gameplay txs and every ephemeral account. */
  er: Connection;
};

export function makeConnections(cfg: ClusterConfig): Connections {
  return {
    base: new Connection(cfg.baseRpc, {
      commitment: "confirmed",
      wsEndpoint: cfg.baseWs,
    }),
    er: new Connection(cfg.erRpc, {
      commitment: "confirmed",
      wsEndpoint: cfg.erWs,
    }),
  };
}
