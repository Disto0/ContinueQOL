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
