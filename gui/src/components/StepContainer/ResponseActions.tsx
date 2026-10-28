import {
  ArrowsPointingInIcon,
  BarsArrowDownIcon,
  InformationCircleIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { ChatHistoryItem } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { useAppSelector } from "../../redux/hooks";
import { useCompactConversation } from "../../util/compactConversation";
import { FeedbackButtons } from "../FeedbackButtons";
import { CopyIconButton } from "../gui/CopyIconButton";
import HeaderButtonWithToolTip from "../gui/HeaderButtonWithToolTip";
import { ToolTip } from "../gui/Tooltip";

// Compact absolute timestamp: YYMMDD-HH:MM (local time).
function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getFullYear() % 100)}${pad(d.getMonth() + 1)}${pad(
    d.getDate(),
  )}-${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface ResponseActionsProps {
  isTruncated: boolean;
  onContinueGeneration: () => void;
  index: number;
  onDelete: () => void;
  item: ChatHistoryItem;
  isLast: boolean;
}

export default function ResponseActions({
  onContinueGeneration,
  index,
  item,
  isTruncated,
  onDelete,
  isLast,
}: ResponseActionsProps) {
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const isPruned = useAppSelector((state) => state.session.isPruned);

  const percent = Math.round((contextPercentage ?? 0) * 100);
  const buttonColorClass =
    isLast && (isPruned || percent > 80)
      ? "text-warning"
      : "text-description-muted";

  const showLabel = isLast && (isPruned || percent >= 60);

  const compactConversation = useCompactConversation();

  // Added by this fork: per-message timestamp + model info tooltip.
  const timestamp = item.timestamp;
  const lastPromptLog = item.promptLogs?.at(-1);
  const modelTitle = lastPromptLog?.modelTitle;
  // Server-reported usage lives on the PromptLog (filled by the core from the
  // final stream chunk); `message.usage` is only set by some providers that
  // attach usage directly. Prefer the prompt log, fall back to the message.
  const usage =
    lastPromptLog?.usage ??
    (item.message.role === "assistant" ? item.message.usage : undefined);

  return (
    <div className="text-description-muted mx-2 flex cursor-default items-center justify-end space-x-1 bg-transparent pb-0 text-xs">
      {timestamp !== undefined && (
        <ToolTip
          place="top"
          content={
            <div className="flex flex-col gap-0.5 text-left">
              <span>{formatTimestamp(timestamp)}</span>
              {modelTitle && <span>{modelTitle}</span>}
              {usage && (
                <span>
                  {`in ${usage.promptTokens ?? 0} / out ${
                    usage.completionTokens ?? 0
                  } tokens`}
                </span>
              )}
            </div>
          }
        >
          <span
            data-testid={`message-timestamp-${index}`}
            className="text-description-muted mr-auto flex cursor-default items-center gap-1 whitespace-nowrap"
          >
            <InformationCircleIcon className="h-3.5 w-3.5" />
            {formatTimestamp(timestamp)}
          </span>
        </ToolTip>
      )}

      <HeaderButtonWithToolTip
        testId={`compact-button-${index}`}
        text={
          showLabel
            ? "Summarize conversation to reduce context length"
            : "Compact conversation"
        }
        tabIndex={-1}
        onClick={() => compactConversation(index)}
      >
        <div className="flex items-center space-x-1">
          <ArrowsPointingInIcon
            className={`h-3.5 w-3.5 ${buttonColorClass || "text-description-muted"}`}
          />
          {showLabel && (
            <span
              className={`text-xs ${buttonColorClass || "text-description-muted"}`}
            >
              Compact conversation
            </span>
          )}
        </div>
      </HeaderButtonWithToolTip>

      {isTruncated && (
        <HeaderButtonWithToolTip
          tabIndex={-1}
          text="Continue generation"
          onClick={onContinueGeneration}
        >
          <BarsArrowDownIcon className="text-description-muted h-3.5 w-3.5" />
        </HeaderButtonWithToolTip>
      )}

      <HeaderButtonWithToolTip
        testId={`delete-button-${index}`}
        text="Delete"
        tabIndex={-1}
        onClick={onDelete}
      >
        <TrashIcon className="text-description-muted h-3.5 w-3.5" />
      </HeaderButtonWithToolTip>

      <CopyIconButton
        tabIndex={-1}
        text={renderChatMessage(item.message)}
        clipboardIconClassName="h-3.5 w-3.5 text-description-muted"
        checkIconClassName="h-3.5 w-3.5 text-success"
      />

      <FeedbackButtons item={item} />
    </div>
  );
}
