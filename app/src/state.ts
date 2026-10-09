// App state: cluster handles (fixed for the page) and the session-scoped pieces the screens
// share (wallet, Player, session + sender, selected world, PlayerState subscription).
// Plain object + change listeners; screens read `app.*` and call `set` to update.
import type { PublicKey } from "@solana/web3.js";
import {
  browserStorage,
  loadConfig,
  makeConnections,
  makeProgram,
  sessionAuth,
  type Auth,
  type ClusterConfig,
  type Connections,
  type ErSender,
  type KeyValueStore,
  type MagicraftProgram,
  type PlayerStateAccount,
  type Session,
  type WorldAccount,
} from "./chain";
import type { AppWallet } from "./wallet";

export type AppState = {
  wallet: AppWallet | null;
  /** The wallet's Player PDA (set with the wallet). */
  player: PublicKey | null;
  session: Session | null;
  /** ER sender signing with the session key (its `payer` is swapped on renewal). */
  sender: ErSender | null;
  /** The session was rejected onchain (expired / revoked): renew before sending. */
  sessionStale: boolean;
  world: { pubkey: PublicKey; account: WorldAccount } | null;
  playerState: PlayerStateAccount | null;
};

export type App = {
  cfg: ClusterConfig;
  conns: Connections;
  /** Ix builder / coder (bound to the ER connection). */
  program: MagicraftProgram;
  store: KeyValueStore | null;
  state: AppState;
  set(patch: Partial<AppState>): void;
  /** Subscribes to state changes; returns an unsubscribe. */
  on(cb: (s: AppState, patch: Partial<AppState>) => void): () => void;
  /** Session auth for gameplay builders (throws without a session). */
  auth(): Auth;
};

export function createApp(env: Record<string, string | boolean | undefined>): App {
  const cfg = loadConfig(env);
  const conns = makeConnections(cfg);
  const listeners = new Set<(s: AppState, p: Partial<AppState>) => void>();
  const app: App = {
    cfg,
    conns,
    program: makeProgram(cfg, conns.er),
    store: browserStorage(),
    state: { wallet: null, player: null, session: null, sender: null, sessionStale: false, world: null, playerState: null },
    set(patch) {
      Object.assign(app.state, patch);
      for (const l of listeners) {
        try {
          l(app.state, patch);
        } catch (e) {
          console.error(e);
        }
      }
    },
    on(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    auth() {
      const { session, player } = app.state;
      if (!session || !player) throw new Error("no session");
      return sessionAuth(session, player);
    },
  };
  return app;
}
