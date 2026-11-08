import { ChatHistoryItem, ContextWindowState } from "core";
import { getAnchorKey } from "core/llm/messages";

type HistoryWithMessageId = ChatHistoryItem & {
  message: { id?: string; role: string };
};

/**
 * Added by this fork (select-GUI / enforce-core): decide which history turns to
 * send on an incremental request, given the window the core actually kept last
 * turn.
 *
 * The rule is precisely:
 *  - ALWAYS keep the active exchange: every turn from the last user-or-tool
 *    message to the end (this is where genuinely-new content lives, and it is
 *    what guarantees a valid, self-consistent tail for the core).
 *  - Keep a turn the core KEPT last turn (its anchor key is in includedIds, or
 *    it is pinned).
 *  - Keep a turn that is genuinely NEW since the last capture (not in knownIds)
 *    — this is the same as the active exchange but is a belt-and-braces guard.
 *  - DROP a turn the core CUT last turn (it was in knownIds but is neither kept,
 *    pinned, nor part of the active exchange). Re-sending such cut turns is
 *    exactly what re-created a phantom delta on top of the server baseline,
 *    keeping the context pinned at ~100%. Dropping them is the fix.
 *
 * Unkeyable items (role not user/assistant/thinking/tool, e.g. a bare system
 * entry) are kept: they are not what we prune by and the core handles them.
 *
 * When no window exists yet (first incremental turn, or an invalidated anchor)
 * the full history is returned unchanged, so behavior matches the previous
 * incremental fallback (core decides with a full local estimate).
 */
export function selectWindowHistory<T extends HistoryWithMessageId>(
  history: T[],
  windowState: ContextWindowState | undefined,
): T[] {
  if (!windowState) {
    return history;
  }

  const kept = new Set<string>([
    ...windowState.includedIds,
    ...windowState.pinnedIds,
  ]);
  const known = new Set<string>(windowState.knownIds ?? []);

  // Start of the protected active exchange (last user-or-tool message).
  let activeStart = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const role = history[i].message.role;
    if (role === "user" || role === "tool") {
      activeStart = i;
      break;
    }
  }

  return history.filter((item, index) => {
    if (index >= activeStart) {
      return true; // active exchange is always sent
    }
    const key = getAnchorKey(item.message as any);
    if (key === undefined) {
      return true; // unkeyable: never pruned here, core handles it
    }
    if (kept.has(key)) {
      return true; // core kept it (or pinned) last turn
    }
    if (!known.has(key)) {
      return true; // genuinely new since last capture
    }
    return false; // known but core cut it last turn -> do NOT re-introduce
  });
}
