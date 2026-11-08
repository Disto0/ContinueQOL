import { useMemo, useRef } from "react";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { saveCurrentSession } from "../../redux/thunks/session";
import { useCompactConversation } from "../../util/compactConversation";
import { ToolTip } from "../gui/Tooltip";

function formatTokens(n: number): string {
  return n.toLocaleString();
}

const ContextStatus = () => {
  const dispatch = useAppDispatch();
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const contextTokens = useAppSelector((state) => state.session.contextTokens);
  const selectedChatModel = useAppSelector(
    (state) => state.config.config.selectedModelByRole.chat?.model,
  );
  const previousHistoryLength = useRef<number | null>(null);
  const previousSelectedChatModel = useRef<string | null>(null);
  const history = useAppSelector((state) => state.session.history);
  const percent = Math.round((contextPercentage ?? 0) * 100);
  const isPruned = useAppSelector((state) => state.session.isPruned);

  // Added by this fork: the active token calibration (factor + the model it was
  // measured for) and whether server-based counting is enabled. Kept at the top
  // with the other hooks (before any early return) to respect the Rules of Hooks.
  const tokenCalibration = useAppSelector(
    (state) => state.session.tokenCalibration,
  );
  const contextTokenMode = useAppSelector(
    (state) => state.config.config.ui?.contextTokenMode ?? "local",
  );
  const serverAnchor = useAppSelector((state) => state.session.serverAnchor);
  const windowState = useAppSelector((state) => state.session.windowState);

  // Added by this fork (diagnostic): server-reported usage from the most recent
  // assistant request. OpenAI-compatible servers report `usage` on the final
  // stream chunk, which the core now surfaces via PromptLog. Used to compare the
  // server's real token count against Continue's local (inflated) estimate.
  // Kept next to the other hooks (before any early return) to respect the Rules
  // of Hooks — a useMemo placed after a conditional `return null` changes the
  // hook count between renders and crashes React (minified error #310).
  const serverUsage = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (item.message.role === "assistant") {
        const usage = item.promptLogs?.at(-1)?.usage;
        if (usage) {
          return {
            promptTokens: usage.promptTokens ?? 0,
            completionTokens: usage.completionTokens ?? 0,
          };
        }
      }
    }
    return undefined;
  }, [history]);

  const isDifferentModelAndSameHistory = useMemo(() => {
    if (!selectedChatModel) return false;
    // only reset if history changes
    if (previousHistoryLength.current !== history.length) {
      previousHistoryLength.current = history.length;
      previousSelectedChatModel.current = selectedChatModel;
      return false;
    }
    return previousSelectedChatModel.current !== selectedChatModel;
  }, [history.length, selectedChatModel]);

  const compactConversation = useCompactConversation();
  if (!isPruned && percent < 1 && !contextPercentage) {
    return null;
  }

  // if user changed to a different model, we shouldn't show the context status until the user sends a new message
  if (isDifferentModelAndSameHistory) {
    return null;
  }

  const barColorClass = isPruned ? "bg-error" : "bg-description";

  // Absolute token counts are only available after a send that ran
  // compileChatMessages on a core build that reports them (this fork).
  const hasAbsoluteTokens =
    contextTokens !== undefined && contextTokens.available > 0;

  // Added by this fork: with calibration on, `contextTokens.used` is the
  // calibrated count (local estimate × factor). Divide back out to recover the
  // raw local-tokenizer count Continue *would* have shown without the feature,
  // and surface how many phantom tokens the calibration strips (= the real
  // context recovered as a result).
  const localUncalibrated =
    hasAbsoluteTokens && tokenCalibration
      ? Math.round(contextTokens.used / tokenCalibration.factor)
      : undefined;
  const recoveredTokens =
    localUncalibrated !== undefined && contextTokens
      ? localUncalibrated - contextTokens.used
      : undefined;

  // Added by this fork (2c-4 diagnostic): the GUI-owned window. Shows how many
  // turns are actually in the window (kept) vs how many previously-sent turns are
  // being SUPPRESSED because the core cut them last turn (knownIds minus kept and
  // pinned). Suppression > 0 is proof the phantom-delta fix is active: those cut
  // turns are no longer re-sent, so no phantom re-count, so real context is
  // recovered. Plain value (not a hook), placed after the early returns.
  const windowDiagnostics = (() => {
    if (!windowState) {
      return undefined;
    }
    const kept = new Set([
      ...windowState.includedIds,
      ...windowState.pinnedIds,
    ]);
    const known = windowState.knownIds ?? [];
    const suppressed = known.filter((key) => !kept.has(key)).length;
    return {
      keptNodes: windowState.includedIds.length,
      pinnedNodes: windowState.pinnedIds.length,
      suppressed,
    };
  })();

  return (
    <div>
      <ToolTip
        closeEvents={{
          // blur: false,
          mouseleave: true,
          click: true,
          mouseup: false,
        }}
        clickable
        content={
          <div className="flex flex-col gap-1 text-left text-xs">
            {hasAbsoluteTokens ? (
              <span className="inline-block">
                {`${formatTokens(contextTokens.used)} / ${formatTokens(
                  contextTokens.available,
                )} tokens (${percent}%)`}
              </span>
            ) : (
              <span className="inline-block">
                {`${percent}% of context filled.`}
              </span>
            )}
            {hasAbsoluteTokens && contextTokens.breakdown && (
              <div className="flex flex-col gap-0.5 text-[10px] opacity-80">
                <span>{`System: ${formatTokens(
                  contextTokens.breakdown.system,
                )}`}</span>
                <span>{`Tools: ${formatTokens(
                  contextTokens.breakdown.tools,
                )}`}</span>
                <span>{`History: ${formatTokens(
                  contextTokens.breakdown.history,
                )}`}</span>
                <span>{`Last message: ${formatTokens(
                  contextTokens.breakdown.lastSequence,
                )}`}</span>
              </div>
            )}
            {/* Added by this fork (diagnostic): server-reported usage vs Continue's
                local estimate, so the gap can be measured on real conversations. */}
            {serverUsage && (
              <div className="flex flex-col gap-0.5 border-t border-solid border-current pt-1 text-[10px] opacity-80">
                <span>{`Server input: ${formatTokens(
                  serverUsage.promptTokens,
                )} tokens`}</span>
                <span>{`Server output: ${formatTokens(
                  serverUsage.completionTokens,
                )} tokens`}</span>
                {hasAbsoluteTokens && (
                  <span>{`Estimate gap: ${formatTokens(
                    contextTokens.used - serverUsage.promptTokens,
                  )} tokens (${(
                    contextTokens.used / Math.max(serverUsage.promptTokens, 1)
                  ).toFixed(2)}×)`}</span>
                )}
              </div>
            )}
            {/* Added by this fork: server-referenced token counting state. Shows
                the active mode and its reference (calibration factor, or the
                server-anchored baseline for incremental mode) so the
                real-vs-estimated split is visible while the feature is validated.
                Hidden in local mode. */}
            {contextTokenMode !== "local" && (
              <div className="flex flex-col gap-0.5 border-t border-solid border-current pt-1 text-[10px] opacity-80">
                <span>{`Token counting: ${contextTokenMode}`}</span>
                {contextTokenMode === "incremental" ? (
                  serverAnchor ? (
                    <>
                      <span>{`Server anchor: ${formatTokens(
                        serverAnchor.promptTokens,
                      )} tokens across ${serverAnchor.anchoredKeys.length} messages (model: ${serverAnchor.modelTitle})`}</span>
                      <span>{`Next request will trust this baseline and only estimate newly added messages.`}</span>
                      {windowDiagnostics && (
                        <span>{`Window: ${windowDiagnostics.keptNodes} kept, ${windowDiagnostics.pinnedNodes} pinned${
                          windowDiagnostics.suppressed > 0
                            ? `, ${windowDiagnostics.suppressed} core-cut turns suppressed (not re-sent)`
                            : ""
                        }`}</span>
                      )}
                    </>
                  ) : (
                    <span>{`Incremental: not yet anchored (using local estimate)`}</span>
                  )
                ) : tokenCalibration ? (
                  <>
                    <span>{`Calibration factor: ${tokenCalibration.factor.toFixed(
                      2,
                    )}× (model: ${tokenCalibration.modelTitle})`}</span>
                    {localUncalibrated !== undefined && (
                      <span>{`Local tokenizer (no calibration): ${formatTokens(
                        localUncalibrated,
                      )} tokens`}</span>
                    )}
                    {recoveredTokens !== undefined && (
                      <span>{`Context recovered: ${formatTokens(
                        recoveredTokens,
                      )} tokens`}</span>
                    )}
                  </>
                ) : (
                  <span>{`Calibration: not yet measured (using local estimate)`}</span>
                )}
              </div>
            )}
            {isPruned && (
              <span className="inline-block">
                {`Oldest messages are being removed.`}
              </span>
            )}
            {history.length > 0 && (
              <div className="flex flex-col gap-1 whitespace-pre">
                <div>
                  <span
                    className="hover:text-link inline-block cursor-pointer underline"
                    onClick={() => compactConversation(history.length - 1)}
                  >
                    Compact conversation
                  </span>
                  {"\n"}
                  <span
                    className="hover:text-link inline-block cursor-pointer underline"
                    onClick={() => {
                      void dispatch(
                        saveCurrentSession({
                          openNewSession: true,
                          generateTitle: false,
                        }),
                      );
                    }}
                  >
                    Start a new session
                  </span>
                </div>
              </div>
            )}
          </div>
        }
      >
        {hasAbsoluteTokens ? (
          // Clickable button: mini bar + absolute counts, e.g. "1,240 / 128,000".
          <div className="border-command-border hover:border-description flex cursor-pointer flex-row items-center gap-1 rounded-[2px] border-[0.5px] border-solid px-1 py-0.5 transition-colors duration-200">
            <div className="border-command-border relative h-[10px] w-[5px] rounded-[1px] border-[0.5px] border-solid">
              <div
                className={`transition-height absolute bottom-0 left-0 w-full duration-300 ease-in-out ${barColorClass}`}
                style={{ height: `${Math.max(percent, 2)}%` }}
              />
            </div>
            <span className="whitespace-nowrap">
              {`${formatTokens(contextTokens.used)} / ${formatTokens(
                contextTokens.available,
              )}`}
            </span>
          </div>
        ) : (
          <div className="border-command-border relative h-[14px] w-[7px] rounded-[1px] border-[0.5px] border-solid md:h-[10px] md:w-[5px]">
            <div
              className={`transition-height absolute bottom-0 left-0 w-full duration-300 ease-in-out ${barColorClass}`}
              style={{ height: `${percent}%` }}
            />
          </div>
        )}
      </ToolTip>
    </div>
  );
};

export default ContextStatus;
