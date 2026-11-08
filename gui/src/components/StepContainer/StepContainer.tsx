import { ChatHistoryItem } from "core";
import { getAnchorKey } from "core/llm/messages";
import { renderChatMessage, stripImages } from "core/util/messageContent";
import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { useAppSelector } from "../../redux/hooks";
import { selectUIConfig } from "../../redux/slices/configSlice";
import { deleteMessage } from "../../redux/slices/sessionSlice";
import ThinkingBlockPeek from "../mainInput/belowMainInput/ThinkingBlockPeek";
import StyledMarkdownPreview from "../StyledMarkdownPreview";
import ConversationSummary from "./ConversationSummary";
import ResponseActions from "./ResponseActions";
import ThinkingIndicator from "./ThinkingIndicator";

interface StepContainerProps {
  item: ChatHistoryItem;
  index: number;
  isLast: boolean;
  latestSummaryIndex?: number;
}

export default function StepContainer(props: StepContainerProps) {
  const dispatch = useDispatch();
  const [isTruncated, setIsTruncated] = useState(false);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const uiConfig = useAppSelector(selectUIConfig);

  // Calculate dimming and indicator state based on latest summary index
  const latestSummaryIndex = props.latestSummaryIndex ?? -1;
  const isBeforeLatestSummary =
    latestSummaryIndex !== -1 && props.index <= latestSummaryIndex;
  const isLatestSummary =
    latestSummaryIndex !== -1 && props.index === latestSummaryIndex;

  const historyItemAfterThis = useAppSelector(
    (state) => state.session.history[props.index + 1],
  );
  const showResponseActions =
    (props.isLast || historyItemAfterThis?.message.role === "user") &&
    !(props.isLast && (isStreaming || props.item.toolCallStates));

  // Added by this fork: visual feedback for the GUI-owned context window, shown
  // only in incremental mode where windowState genuinely knows which turns are
  // in the active window. This lets the user SEE what is actually being kept vs
  // dropped, and which turns they have pinned.
  //  - pinned : key present in windowState.pinnedIds          -> yellow left bar
  //  - pruned : known last turn but NOT kept and NOT pinned   -> dimmed + grey bar
  //            (i.e. the core cut it last turn and we do not re-send it)
  // Pinned wins over pruned. Messages never sent yet are neither. Compact-compacted
  // messages keep their existing dim + horizontal divider, so a vertical left bar
  // clearly dissociates pruned/pinned from compacted.
  const contextTokenMode = useAppSelector(
    (state) => state.config.config.ui?.contextTokenMode ?? "local",
  );
  const windowState = useAppSelector((state) => state.session.windowState);
  const isWindowVisual = contextTokenMode === "incremental" && !!windowState;
  const anchorKey = isWindowVisual
    ? getAnchorKey(props.item.message)
    : undefined;
  const isPinned =
    isWindowVisual &&
    anchorKey !== undefined &&
    !!windowState?.pinnedIds.includes(anchorKey);
  const isPrunedNode =
    isWindowVisual &&
    !isPinned &&
    anchorKey !== undefined &&
    !!windowState?.knownIds?.includes(anchorKey) &&
    !windowState.includedIds.includes(anchorKey);

  useEffect(() => {
    if (!isStreaming) {
      const content = renderChatMessage(props.item.message).trim();
      const endingPunctuation = [".", "?", "!", "```", ":"];

      // If not ending in punctuation or emoji, we assume the response got truncated
      if (
        content.trim() !== "" &&
        !(
          endingPunctuation.some((p) => content.endsWith(p)) ||
          /\p{Emoji}/u.test(content.slice(-2))
        )
      ) {
        setIsTruncated(true);
      } else {
        setIsTruncated(false);
      }
    }
  }, [props.item.message.content, isStreaming]);

  function onDelete() {
    dispatch(deleteMessage(props.index));
  }

  function onContinueGeneration() {
    window.postMessage(
      {
        messageType: "userInput",
        data: {
          input: "Continue your response exactly where you left off:",
        },
      },
      "*",
    );
  }

  return (
    <div>
      <div
        className={`bg-background p-1 px-1.5 ${
          isBeforeLatestSummary ? "opacity-35" : ""
        } ${
          // Added by this fork: left-bar + dim feedback for the GUI context window.
          // Pinned -> yellow left bar (protected). Pruned/out-of-window -> dimmed +
          // grey left bar (dropped by the core last turn, not re-sent). A vertical
          // bar clearly dissocates these from compacted messages (which use the
          // horizontal "Compacted" divider). Only rendered in incremental mode.
          isPinned
            ? "border-warning border-l-4 border-solid"
            : isPrunedNode
              ? "border-description border-l-4 border-solid opacity-45"
              : ""
        }`}
      >
        {uiConfig?.displayRawMarkdown ? (
          <pre className="text-2xs max-w-full overflow-x-auto whitespace-pre-wrap break-words p-4">
            {renderChatMessage(props.item.message)}
          </pre>
        ) : (
          <>
            {props.item.reasoning?.text?.trim() && (
              <ThinkingBlockPeek
                content={props.item.reasoning.text}
                index={props.index}
                prevItem={props.index > 0 ? props.item : null}
                inProgress={!props.item.reasoning?.endAt}
              />
            )}

            <StyledMarkdownPreview
              isRenderingInStepContainer
              source={stripImages(props.item.message.content)}
              itemIndex={props.index}
            />
          </>
        )}
        {props.isLast && <ThinkingIndicator historyItem={props.item} />}
      </div>

      {showResponseActions && (
        <div
          className={`mt-2 h-7 transition-opacity duration-300 ease-in-out ${isBeforeLatestSummary || isStreaming ? "opacity-35" : ""} ${isStreaming && "pointer-events-none cursor-not-allowed"}`}
        >
          <ResponseActions
            isTruncated={isTruncated}
            onDelete={onDelete}
            onContinueGeneration={onContinueGeneration}
            index={props.index}
            item={props.item}
            isLast={props.isLast}
          />
        </div>
      )}

      {/* Show compaction indicator for the latest summary */}
      {isLatestSummary && (
        <div className="mx-1.5 my-5">
          <div className="flex items-center">
            <div className="border-border flex-1 border-t border-solid"></div>
            <span className="text-description mx-3 text-xs">
              Previous Conversation Compacted
            </span>
            <div className="border-border flex-1 border-t border-solid"></div>
          </div>
        </div>
      )}

      {/* ConversationSummary is outside the dimmed container so it's always at full opacity */}
      <ConversationSummary item={props.item} index={props.index} />
    </div>
  );
}
