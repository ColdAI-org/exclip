/**
 * Follows submitted intents until SODAX reports them solved or failed. It runs only while the wallet runtime is loaded
 * (status needs the SDK) and the tab is visible, and updates the activity log, which the trade sheet's progress
 * screen and the order tables read.
 */
import { useEffect } from "react";
import { updateActivity, useActivity, type Activity } from "./activity";
import { walletActions, useWallet } from "./wallet";

// SODAX intent status codes (swaps.getStatus): 3 = solved, 4 = failed; -1, 1 and 2 are still in progress.
const SOLVED = 3;
const FAILED = 4;
const EVERY_MS = 6000;

const watched = (a: Activity) => (a.status === "solving" || (a.kind === "limit" && a.status === "open")) && !!a.hubTxHash;

export function useIntentWatcher() {
  const list = useActivity();
  const { status } = useWallet();
  const pending = list.filter(watched);
  const key = pending.map(a => a.id).join(",");

  // `pending` is described by `key`.
  useEffect(() => {
    if (!key || status !== "ready") return;
    let stopped = false;
    const tick = async () => {
      const actions = walletActions();
      if (!actions || document.visibilityState !== "visible") return;
      for (const a of pending) {
        if (stopped) return;
        try {
          const s = await actions.status(a.hubTxHash!);
          if (!s) continue;
          if (s.code === SOLVED) updateActivity(a.id, { status: "settled", fillTxHash: s.fillTxHash });
          else if (s.code === FAILED) updateActivity(a.id, { status: "failed", error: "No solver filled this order. Your funds stay in your wallet or are returned automatically." });
        } catch { /* try again on the next tick */ }
      }
    };
    void tick();
    const t = window.setInterval(tick, EVERY_MS);
    return () => { stopped = true; window.clearInterval(t); };
  }, [key, status]);
}
