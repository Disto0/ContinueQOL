import {
  ActionReducerMapBuilder,
  AsyncThunk,
  PayloadAction,
  createSelector,
  createSlice,
} from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ApplyState,
  AssistantChatMessage,
  BaseSessionMetadata,
  ChatHistoryItem,
  ChatMessage,
  ContextItem,
  ContextItemWithId,
  ContextTokenBreakdown,
  ContextWindowState,
  FileSymbolMap,
  McpUiState,
  MessageModes,
  PromptLog,
  RuleMetadata,
  Session,
  ThinkingChatMessage,
  Tool,
  ToolCallDelta,
  ToolCallState,
} from "core";
import { mergeReasoningDetails } from "core/llm/openaiTypeConverters";
import { getAnchorKey } from "core/llm/messages";
import { NEW_SESSION_TITLE } from "core/util/constants";
import {
  renderChatMessage,
  renderContextItems,
} from "core/util/messageContent";
import { findUriInDirs, getUriPathBasename } from "core/util/uri";
import { findLastIndex } from "lodash";
import { v4 as uuidv4 } from "uuid";
import { type InlineErrorMessageType } from "../../components/mainInput/InlineErrorMessage";
import { toolCallCtxItemToCtxItemWithId } from "../../pages/gui/ToolCallDiv/utils";
import { addToolCallDeltaToState, isEditTool } from "../../util/toolCallState";
import { RootState } from "../store";
import { streamResponseThunk } from "../thunks/streamResponse";
import { findChatHistoryItemByToolCallId, findToolCallById } from "../util";

/**
 * Helper function to filter out duplicate edit/search-replace tool calls.
 * Only keeps the first occurrence of edit tools.
 *
 * We don't support multiple parallel apply calls - see tool definitions for
 * instructions we provide to models to prevent this behavior.
 */
function filterMultipleEditToolCalls(
  toolCalls: ToolCallDelta[],
): ToolCallDelta[] {
  let hasSeenEditTool = false;

  return toolCalls.filter((toolCall) => {
    if (toolCall.function?.name && isEditTool(toolCall.function?.name)) {
      if (hasSeenEditTool) {
        return false; // Skip this duplicate edit tool
      }
      hasSeenEditTool = true;
    }

    return true;
  });
}

/**
 * Initializes tool call states for a new message containing tool calls.
 * This function is called when we receive a complete message with tool calls,
 * typically in non-streaming scenarios or when processing the first chunk
 * of a streaming message that contains tool calls.
 *
 * @param message - The chat message containing tool calls to process
 * @param lastItem - The chat history item to attach tool call states to
 */
export function handleToolCallsInMessage(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    (message.role === "assistant" || message.role === "thinking") &&
    message.toolCalls?.length
  ) {
    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Initialize tool call states for each filtered tool call in the message
    // Each tool call gets its own state to track generation/execution progress
    lastItem.toolCallStates = filteredToolCalls.map((toolCallDelta) =>
      addToolCallDeltaToState(toolCallDelta, undefined),
    );

    // Update the message's toolCalls array to reflect the processed tool calls
    // We can safely cast because we verified the role above
    const curMessage = lastItem.message as
      | AssistantChatMessage
      | ThinkingChatMessage;
    curMessage.toolCalls = lastItem.toolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

/**
 * Applies a single tool call delta to the tool call states array.
 *
 * This function handles the core logic for OpenAI-style tool call streaming where:
 * - Initial tool calls come with full details (ID, name, arguments)
 * - Subsequent argument fragments come without IDs and need to update the most recent tool call
 * - Multiple parallel tool calls can be streamed simultaneously
 *
 * @param toolCallDelta - The incoming tool call delta from the LLM stream
 * @param toolCallStates - Array of existing tool call states (modified in place)
 */
function applyToolCallDelta(
  toolCallDelta: ToolCallDelta,
  toolCallStates: ToolCallState[],
): void {
  // Find existing state by matching toolCallId - this ensures we update
  // the correct tool call even when multiple tool calls are being streamed
  let existingStateIndex = -1;

  if (toolCallDelta.id) {
    // Tool call has an ID - find by exact match
    // This handles: new tool calls or explicit updates to existing ones
    existingStateIndex = toolCallStates.findIndex(
      (state) => state.toolCallId === toolCallDelta.id,
    );
  } else {
    // No ID in delta (common in OpenAI streaming fragments)
    // Strategy: Update the most recently added tool call that's still being generated
    // This handles the pattern: initial tool call with ID, then fragments without ID
    existingStateIndex = toolCallStates.length - 1;

    // Ensure we have at least one tool call to update
    if (existingStateIndex < 0) {
      existingStateIndex = -1; // Will create new tool call
    }
  }

  const existingState =
    existingStateIndex >= 0 ? toolCallStates[existingStateIndex] : undefined;

  // Apply the delta to create an updated state (either updating existing or creating new)
  const updatedState = addToolCallDeltaToState(toolCallDelta, existingState);

  if (existingStateIndex >= 0) {
    // Update existing tool call state in place
    toolCallStates[existingStateIndex] = updatedState;
  } else {
    // Add new tool call state for a newly discovered tool call
    toolCallStates.push(updatedState);
  }
}

/**
 * Handles incremental updates to tool calls during streaming responses.
 * This function processes streaming deltas for tool calls, updating existing
 * tool call states or creating new ones as needed. It uses ID-based matching
 * to ensure tool call updates are applied to the correct tool call state.
 *
 * @param message - The streaming message chunk containing tool call deltas
 * @param lastItem - The chat history item containing existing tool call states
 */
export function handleStreamingToolCallUpdates(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    message.role === "assistant" &&
    message.toolCalls?.length &&
    lastItem.message.role === "assistant"
  ) {
    // Start with existing tool call states or empty array if none exist
    const existingToolCallStates = lastItem.toolCallStates || [];
    const updatedToolCallStates: ToolCallState[] = [...existingToolCallStates];

    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Process each filtered tool call delta, matching by ID to update the correct state
    filteredToolCalls.forEach((toolCallDelta) => {
      applyToolCallDelta(toolCallDelta, updatedToolCallStates);
    });

    // Replace the entire tool call states array with the updated version
    lastItem.toolCallStates = updatedToolCallStates;

    // Update the message's toolCalls array to reflect current tool call states
    (lastItem.message as any).toolCalls = updatedToolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

// We need this to handle reorderings (e.g. a mid-array deletion) of the messages array.
// The proper fix is adding a UUID to all chat messages, but this is the temp workaround.
export type ChatHistoryItemWithMessageId = ChatHistoryItem & {
  message: ChatMessage & { id: string };
};

type SessionState = {
  lastSessionId?: string;
  isSessionMetadataLoading: boolean;
  allSessionMetadata: BaseSessionMetadata[];
  history: ChatHistoryItemWithMessageId[];
  isStreaming: boolean;
  title: string;
  id: string;
  streamAborter: AbortController;
  mainEditorContentTrigger?: JSONContent | undefined;
  symbols: FileSymbolMap;
  mode: MessageModes;
  isInEdit: boolean;
  codeBlockApplyStates: {
    states: ApplyState[];
    curIndex: number;
  };
  newestToolbarPreviewForInput: Record<string, string>;
  hasReasoningEnabled?: boolean;
  isPruned?: boolean;
  contextPercentage?: number;
  // Added by this fork: absolute token counts for the active context window,
  // recalculated on every send (never persisted).
  contextTokens?: {
    used: number;
    available: number;
    max: number;
    breakdown?: ContextTokenBreakdown;
  };
  // Added by this fork: measured calibration factor derived from the previous
  // request's server-reported usage (server prompt_tokens / Continue's local
  // estimate). Injected into llm/compileChat so pruning decides on counts that
  // match the server instead of Continue's inflated local tokenizer. Reset to
  // undefined (→ factor 1, local estimate) whenever the message set changes in
  // a way that invalidates the previous measurement. Never persisted.
  // The model title is stored alongside the factor so switching chat models
  // (a different tokenizer) automatically invalidates a stale measurement.
  tokenCalibration?: { factor: number; modelTitle: string };
  // Added by this fork: the server-anchored token baseline for incremental mode.
  // Captures the exact prompt_tokens the server reported for the last successful
  // request AND the anchor keys of the messages it actually counted (echoed back
  // by the core), so the next request can treat those specific messages as
  // already-counted and only locally estimate newly added ones. Keying by id/
  // toolCallId (not a count/index) is what makes the anchor survive the core
  // re-pruning its own older turns. baseSignature fingerprints the non-negotiable
  // system message + active tools; if it changes, the baseline no longer covers
  // them and the anchor is invalidated (→ full local estimate). modelTitle
  // invalidates on a model switch. Not yet persisted across reloads.
  serverAnchor?: {
    promptTokens: number;
    anchoredKeys: string[];
    baseSignature: string;
    modelTitle: string;
  };
  // Added by this fork: the GUI-owned context window (select-GUI / enforce-core).
  // In incremental mode it records which history turns the core actually KEPT on
  // the last send (includedIds), which turns it CUT (implied by knownIds minus
  // includedIds), and the cached per-node token costs. The next incremental send
  // sends only (kept ∪ genuinely-new) turns and never re-introduces cut ones —
  // this is what removes the phantom re-count that kept the context pinned at
  // ~100% despite the server anchor. Tree-ready: addressed by node id, with a
  // reserved parentId in the core node type for future sub-conversations. Reset
  // alongside serverAnchor wherever the message set changes. Not yet persisted.
  windowState?: ContextWindowState;
  inlineErrorMessage?: InlineErrorMessageType;
  compactionLoading: Record<number, boolean>; // Track compaction loading by message index
};

export const INITIAL_SESSION_STATE: SessionState = {
  isSessionMetadataLoading: false,
  allSessionMetadata: [],
  history: [],
  isStreaming: false,
  title: NEW_SESSION_TITLE,
  id: uuidv4(),
  streamAborter: new AbortController(),
  symbols: {},
  mode: "agent",
  isInEdit: false,
  codeBlockApplyStates: {
    states: [],
    curIndex: 0,
  },
  lastSessionId: undefined,
  newestToolbarPreviewForInput: {},
  compactionLoading: {},
};

export const sessionSlice = createSlice({
  name: "session",
  initialState: INITIAL_SESSION_STATE,
  reducers: {
    addPromptCompletionPair: (
      state,
      { payload }: PayloadAction<PromptLog[]>,
    ) => {
      if (!state.history.length) {
        return;
      }

      const lastMessage = state.history[state.history.length - 1];

      lastMessage.promptLogs = lastMessage.promptLogs
        ? lastMessage.promptLogs.concat(payload)
        : payload;

      // Inactive thinking for reasoning models when '</think>' tag is not received on request completion
      if (lastMessage.reasoning?.active) {
        lastMessage.reasoning.active = false;
        lastMessage.reasoning.endAt = Date.now();
      }
    },
    setActive: (state) => {
      state.isStreaming = true;
    },
    setIsGatheringContext: (state, { payload }: PayloadAction<boolean>) => {
      const curMessage = state.history.at(-1);
      if (curMessage) {
        curMessage.isGatheringContext = payload;
      }
    },
    clearDanglingMessages: (state) => {
      // This is used during cancellation
      // After the last user or tool message, we can have thinking and or valid assitant message (content or generated tool calls) OR nothing.
      // The only thing allowed after the last assistant message that has either content or generated tool calls
      // is a user or tool message
      if (state.history.length < 2) {
        return;
      }

      const lastUserOrToolIdx = findLastIndex(
        state.history,
        (item) => item.message.role === "tool" || item.message.role === "user",
      );

      let validAssistantMessageIdx = -1;
      for (let i = state.history.length - 1; i > lastUserOrToolIdx; i--) {
        const message = state.history[i];
        const hasGeneratedMsg = message.toolCallStates?.some(
          (toolCallState) => toolCallState.status !== "generating",
        );
        if (message.message.content || hasGeneratedMsg) {
          validAssistantMessageIdx = i;
          // Cancel any tool calls that are dangling and generated
          if (message.toolCallStates) {
            message.toolCallStates.forEach((toolCallState) => {
              if (
                toolCallState.status === "generated" ||
                toolCallState.status === "generating"
              ) {
                toolCallState.status = "canceled";
              }
            });
          }
          break;
        }
      }

      if (validAssistantMessageIdx === -1) {
        const lastMsg = state.history[lastUserOrToolIdx];
        const lastRole = lastMsg.message.role as "user" | "tool";
        if (lastRole === "user") {
          state.mainEditorContentTrigger = lastMsg.editorState;
          state.history = state.history.slice(0, lastUserOrToolIdx);
        } else {
          state.history = state.history.slice(0, lastUserOrToolIdx + 1);
        }
      } else {
        state.history = state.history.slice(0, validAssistantMessageIdx + 1);
      }
    },
    // Trigger value picked up by editor with isMainInput to set its content
    setMainEditorContentTrigger: (
      state,
      action: PayloadAction<JSONContent | undefined>,
    ) => {
      state.mainEditorContentTrigger = action.payload;
    },
    updateFileSymbols: (state, action: PayloadAction<FileSymbolMap>) => {
      state.symbols = {
        ...state.symbols,
        ...action.payload,
      };
    },
    setContextItemsAtIndex: (
      state,
      {
        payload: { index, contextItems },
      }: PayloadAction<{
        index: number;
        contextItems: ChatHistoryItem["contextItems"];
      }>,
    ) => {
      if (state.history[index]) {
        state.history[index].contextItems = contextItems;
      }
    },
    submitEditorAndInitAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        editorState: JSONContent;
      }>,
    ) => {
      const { index, editorState } = payload;

      if (state.history.length && index < state.history.length) {
        // Resubmission - update input message, truncate history after resubmit with new empty response message
        if (index % 2 === 1) {
          console.warn(
            "Corrupted history: resubmitting at odd index, shouldn't happen",
          );
        }
        const historyItem = state.history[index];

        historyItem.message.content = ""; // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
        historyItem.editorState = payload.editorState;
        historyItem.contextItems = [];

        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
          timestamp: Date.now(),
        });
      } else {
        // New input/response messages
        state.history = state.history.concat([
          {
            message: {
              id: uuidv4(),
              role: "user",
              content: "", // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
            },
            contextItems: [],
            editorState,
            timestamp: Date.now(),
          },
          {
            message: {
              id: uuidv4(),
              role: "assistant",
              content: "", // IMPORTANT - this is subsequently updated by response streaming
            },
            contextItems: [],
            timestamp: Date.now(),
          },
        ]);
      }

      state.isStreaming = true;
    },
    truncateHistoryToMessage: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
      }>,
    ) => {
      const { index } = payload;

      if (state.history.length && index < state.history.length) {
        state.codeBlockApplyStates.curIndex = 0;
        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
          timestamp: Date.now(),
        });
        state.inlineErrorMessage = undefined;
        state.isPruned = false;
        state.contextPercentage = undefined;
        state.contextTokens = undefined;
        state.tokenCalibration = undefined;
        state.serverAnchor = undefined;
        state.windowState = undefined;
      }
    },
    deleteMessage: (state, action: PayloadAction<number>) => {
      // Deletes the current assistant message and the previous user message
      state.history.splice(action.payload - 1, 2);
      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.contextTokens = undefined;
      state.tokenCalibration = undefined;
      state.serverAnchor = undefined;
      state.windowState = undefined;
    },
    deleteCompaction: (state, action: PayloadAction<number>) => {
      // Removes the conversation summary from the specified message
      const historyItem = state.history[action.payload];
      if (historyItem?.conversationSummary) {
        state.history[action.payload] = {
          ...historyItem,
          conversationSummary: undefined,
        };
      }
    },
    updateHistoryItemAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        updates: Partial<ChatHistoryItemWithMessageId>;
      }>,
    ) => {
      const { index, updates } = payload;
      if (index !== 0 && !state.history[index]) {
        console.error(
          `attempting to update history item at nonexistent index ${index}`,
          updates,
        );
        return;
      }
      state.history[index] = {
        ...state.history[index],
        ...updates,
      };
    },
    addContextItemsAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        contextItems: ContextItemWithId[];
      }>,
    ) => {
      const historyItem = state.history[payload.index];

      if (!historyItem) {
        return;
      }

      historyItem.contextItems = [
        ...historyItem.contextItems,
        ...payload.contextItems,
      ];
    },
    setAppliedRulesAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        appliedRules: RuleMetadata[];
      }>,
    ) => {
      if (state.history[payload.index]) {
        state.history[payload.index].appliedRules = payload.appliedRules;
      }
    },
    setInactive: (state) => {
      const curMessage = state.history.at(-1);

      if (curMessage) {
        curMessage.isGatheringContext = false;
      }

      state.isStreaming = false;
    },
    abortStream: (state) => {
      state.streamAborter.abort();
      state.streamAborter = new AbortController();
    },
    streamUpdate: (state, action: PayloadAction<ChatMessage[]>) => {
      if (state.history.length) {
        for (const message of action.payload) {
          let lastItem = state.history[state.history.length - 1];
          let lastMessage = lastItem.message;

          if (message.role === "thinking" && message.redactedThinking) {
            state.history.push({
              message: {
                role: "thinking",
                content: "internal reasoning is hidden due to safety reasons",
                redactedThinking: message.redactedThinking,
                id: uuidv4(),
              },
              contextItems: [],
              timestamp: Date.now(),
            });
            continue;
          }

          const messageContent = message.content
            ? renderChatMessage(message)
            : "";

          // Added by this fork: skip empty "usage carrier" chunks. The core
          // surfaces server-reported token counts as an assistant message with
          // no content and no tool calls (see fromChatCompletionChunk). It must
          // not create a phantom empty bubble in the history; the usage itself
          // reaches the GUI via the PromptLog path instead.
          if (
            message.role === "assistant" &&
            !messageContent &&
            !("toolCalls" in message && message.toolCalls?.length)
          ) {
            continue;
          }

          // OpenAI-compatible models in agent mode sometimes send
          // all of their data in one message, so we handle that case early.
          if (messageContent && message.role !== "tool") {
            const thinkMatches = messageContent.match(
              /<think>([\s\S]*)<\/think>([\s\S]*)/,
            );
            if (thinkMatches) {
              // The order that they seem to consistently use is:
              //
              // <think>Thinking text</think>
              // Text to show to the user

              lastItem.reasoning = {
                text: thinkMatches[1].trim(),
                startAt: Date.now(),
                endAt: Date.now(),
                active: false,
              };

              // This is the chat message that we should show to the user.
              // We always need to push this even if it is empty,
              // because we cannot attach tool calls to a Thinking message.
              // That would break `messageHasToolCallId`.
              state.history.push({
                message: {
                  role: "assistant",
                  content: thinkMatches[2].trim(),
                  id: uuidv4(),
                },
                contextItems: [],
                timestamp: Date.now(),
              });
              lastItem = state.history[state.history.length - 1];
              lastMessage = lastItem.message;

              handleToolCallsInMessage(message, lastItem);

              return;
            }
          }

          // The remainder of this function handles streaming messages
          if (
            lastMessage.role !== message.role ||
            message.role === "tool" // Tool messages should always create new messages
          ) {
            // Create a new message
            const historyItem: ChatHistoryItemWithMessageId = {
              message: {
                ...message,
                content: "", // Start with empty content, let accumulation logic handle it
                id: uuidv4(),
              },
              contextItems: [],
              timestamp: Date.now(),
            };
            state.history.push(historyItem);
            lastItem = state.history[state.history.length - 1];
            lastMessage = lastItem.message;
          }

          // Add to the existing message
          if (messageContent) {
            if (messageContent.includes("<think>") && message.role !== "tool") {
              lastItem.reasoning = {
                startAt: Date.now(),
                active: true,
                text: messageContent.replace("<think>", "").trim(),
              };
            } else if (
              lastItem.reasoning?.active &&
              messageContent.includes("</think>")
            ) {
              const [reasoningEnd, answerStart] =
                messageContent.split("</think>");
              lastItem.reasoning.text += reasoningEnd.trimEnd();
              lastItem.reasoning.active = false;
              lastItem.reasoning.endAt = Date.now();
              lastMessage.content += answerStart.trimStart();
            } else if (lastItem.reasoning?.active) {
              if (
                lastItem.reasoning.text.length > 0 ||
                messageContent.trim().length > 0
              ) {
                lastItem.reasoning.text += messageContent;
              }
            } else {
              // Note this only works because new message above
              // was already rendered from parts to string
              if (
                lastMessage.content.length > 0 ||
                messageContent.trim().length > 0
              ) {
                lastMessage.content += messageContent;
              }
            }
          } else if (message.role === "thinking" && message.signature) {
            if (lastMessage.role === "thinking") {
              lastMessage.signature = message.signature;
            }
          } else if (
            message.role === "assistant" &&
            message.toolCalls?.length &&
            lastMessage.role === "assistant"
          ) {
            handleStreamingToolCallUpdates(message, lastItem);
          }

          // Attach Responses API output item id to the current assistant message if present
          // fromResponsesChunk sets message.metadata.responsesOutputItemId when it sees output_item.added for messages
          if (
            message.role === "assistant" &&
            lastMessage.role === "assistant" &&
            message.metadata?.responsesOutputItemId
          ) {
            lastMessage.metadata = lastMessage.metadata || {};
            // Accumulate fc_ IDs for parallel tool calls (OpenAI Responses API)
            if (!lastMessage.metadata.responsesOutputItemIds) {
              lastMessage.metadata.responsesOutputItemIds = [];
            }
            (lastMessage.metadata.responsesOutputItemIds as string[]).push(
              message.metadata.responsesOutputItemId as string,
            );
            // Also keep singular for backwards compatibility
            lastMessage.metadata.responsesOutputItemId = message.metadata
              .responsesOutputItemId as string;
          }

          if (
            message.role === "thinking" &&
            message.reasoning_details &&
            lastMessage.role === "thinking"
          ) {
            lastMessage.reasoning_details = mergeReasoningDetails(
              lastMessage.reasoning_details,
              message.reasoning_details,
            );
          }
        }
      }
    },
    newSession: (state, { payload }: PayloadAction<Session | undefined>) => {
      state.lastSessionId = state.id;

      state.streamAborter.abort();
      state.streamAborter = new AbortController();

      state.isStreaming = false;
      state.symbols = {};

      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.contextTokens = undefined;
      state.tokenCalibration = undefined;
      state.serverAnchor = undefined;
      state.windowState = undefined;

      if (payload) {
        state.history = payload.history as any;
        state.title = payload.title;
        state.id = payload.sessionId;
        if (payload.mode) {
          state.mode = payload.mode;
        }
        // Added by this fork: restore the persisted context-accounting snapshot
        // so the context bar/tooltip is visible immediately on load (it would
        // otherwise stay hidden until the next send recomputes it).
        state.contextTokens = payload.contextTokens;
        state.contextPercentage = payload.contextPercentage;
        state.tokenCalibration = payload.tokenCalibration;
        // Added by this fork (2b-3): restore the incremental anchor + window so a
        // reloaded session keeps its server-referenced accounting and does not
        // re-introduce core-cut turns. The anchor is re-validated (model +
        // system/tools fingerprint) on the next send, so a stale one is simply
        // not trusted rather than applied wrongly.
        state.serverAnchor = payload.serverAnchor;
        state.windowState = payload.windowState;
      } else {
        state.history = [];
        state.title = NEW_SESSION_TITLE;
        state.id = uuidv4();
      }
    },
    updateSessionTitle: (state, { payload }: PayloadAction<string>) => {
      state.title = payload;
    },
    setIsSessionMetadataLoading: (
      state,
      { payload }: PayloadAction<boolean>,
    ) => {
      state.isSessionMetadataLoading = payload;
    },
    setAllSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata[]>,
    ) => {
      state.allSessionMetadata = payload;
    },
    //////////////////////////////////////////////////////////////////////////////////
    // These are for optimistic session metadata updates, especially for History page
    addSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata>,
    ) => {
      state.allSessionMetadata = [...state.allSessionMetadata, payload];
    },
    updateSessionMetadata: (
      state,
      {
        payload,
      }: PayloadAction<
        {
          sessionId: string;
        } & Partial<BaseSessionMetadata>
      >,
    ) => {
      state.allSessionMetadata = state.allSessionMetadata.map((session) =>
        session.sessionId === payload.sessionId
          ? {
              ...session,
              ...payload,
            }
          : session,
      );
      if (payload.title && payload.sessionId === state.id) {
        state.title = payload.title;
      }
    },
    deleteSessionMetadata: (state, { payload }: PayloadAction<string>) => {
      // Note, should not be allowed to delete current session from chat session
      state.allSessionMetadata = state.allSessionMetadata.filter(
        (session) => session.sessionId !== payload,
      );
    },
    //////////////////////////////////////////////////////////////////////////////////
    addHighlightedCode: (
      state,
      {
        payload,
      }: PayloadAction<{ rangeInFileWithContents: any; edit: boolean }>,
    ) => {
      let contextItems =
        state.history[state.history.length - 1].contextItems ?? [];

      contextItems = contextItems.map((item) => {
        return { ...item, editing: false };
      });

      const { relativePathOrBasename } = findUriInDirs(
        payload.rangeInFileWithContents.filepath,
        window.workspacePaths ?? [],
      );
      const fileName = getUriPathBasename(
        payload.rangeInFileWithContents.filepath,
      );

      const lineNums = `(${
        payload.rangeInFileWithContents.range.start.line + 1
      }-${payload.rangeInFileWithContents.range.end.line + 1})`;

      contextItems.push({
        name: `${fileName} ${lineNums}`,
        description: relativePathOrBasename,
        id: {
          providerTitle: "code",
          itemId: uuidv4(),
        },
        content: payload.rangeInFileWithContents.contents,
        editing: true,
        editable: true,
        uri: {
          type: "file",
          value: payload.rangeInFileWithContents.filepath,
        },
      });

      state.history[state.history.length - 1].contextItems = contextItems;
    },
    updateApplyState: (state, { payload }: PayloadAction<ApplyState>) => {
      const applyState = state.codeBlockApplyStates.states.find(
        (state) => state.streamId === payload.streamId,
      );

      if (!applyState) {
        state.codeBlockApplyStates.states.push(payload);
      } else {
        applyState.status = payload.status ?? applyState.status;
        applyState.numDiffs = payload.numDiffs ?? applyState.numDiffs;
        applyState.filepath = payload.filepath ?? applyState.filepath;
        applyState.fileContent = payload.fileContent ?? applyState.fileContent;
        applyState.originalFileContent =
          payload.originalFileContent ?? applyState.originalFileContent;
      }

      if (payload.status === "done") {
        state.codeBlockApplyStates.curIndex++;
      }
    },
    resetNextCodeBlockToApplyIndex: (state) => {
      state.codeBlockApplyStates.curIndex = 0;
    },

    // TOOL CALL STATE
    setToolGenerated: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        tools: Tool[];
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );

      if (toolCallState) {
        toolCallState.status = "generated";

        const tool = action.payload.tools.find(
          (t) => t.function.name === toolCallState.toolCall.function.name,
        );
        if (tool) {
          toolCallState.tool = tool;
        }
      }
    },
    updateToolCallOutput: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        contextItems: ContextItem[];
        mcpUiState?: McpUiState;
      }>,
    ) => {
      // Update tool call state and corresponding tool output message
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.output = action.payload.contextItems;
        toolCallState.mcpUiState = action.payload.mcpUiState;
      }
      const toolItem = findChatHistoryItemByToolCallId(
        state.history,
        action.payload.toolCallId,
      );
      if (toolItem) {
        toolItem.message.content = renderContextItems(
          action.payload.contextItems,
        );
        toolItem.contextItems = action.payload.contextItems.map((item) =>
          toolCallCtxItemToCtxItemWithId(item, action.payload.toolCallId),
        );
      }
    },
    setProcessedToolCallArgs: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        newArgs: Record<string, any>;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.processedArgs = action.payload.newArgs;
      }
    },
    cancelToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "canceled";
      }
    },
    errorToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        output?: ContextItem[]; // optional for convenience
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "errored";
        if (action.payload.output) {
          toolCallState.output = action.payload.output;
        }
      }
    },
    acceptToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "done";
      }
    },
    setToolCallCalling: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "calling";
      }
    },
    setMode: (state, action: PayloadAction<MessageModes>) => {
      state.mode = action.payload;
    },
    setIsInEdit: (state, action: PayloadAction<boolean>) => {
      state.isInEdit = action.payload;
    },
    setHasReasoningEnabled: (state, action: PayloadAction<boolean>) => {
      state.hasReasoningEnabled = action.payload;
    },
    setNewestToolbarPreviewForInput: (
      state,
      {
        payload,
      }: PayloadAction<{
        inputId: string;
        contextItemId: string;
      }>,
    ) => {
      state.newestToolbarPreviewForInput[payload.inputId] =
        payload.contextItemId;
    },
    setCompactionLoading: (
      state,
      action: PayloadAction<{ index: number; loading: boolean }>,
    ) => {
      const { index, loading } = action.payload;
      if (loading) {
        state.compactionLoading[index] = true;
      } else {
        delete state.compactionLoading[index];
      }
    },
    setInlineErrorMessage: (
      state,
      action: PayloadAction<SessionState["inlineErrorMessage"]>,
    ) => {
      state.inlineErrorMessage = action.payload;
    },
    setIsPruned: (state, action: PayloadAction<boolean>) => {
      state.isPruned = action.payload;
    },
    setContextPercentage: (state, action: PayloadAction<number>) => {
      state.contextPercentage = action.payload;
    },
    setContextTokens: (
      state,
      action: PayloadAction<SessionState["contextTokens"]>,
    ) => {
      state.contextTokens = action.payload;
    },
    setTokenCalibration: (
      state,
      action: PayloadAction<SessionState["tokenCalibration"]>,
    ) => {
      state.tokenCalibration = action.payload;
    },
    setServerAnchor: (
      state,
      action: PayloadAction<SessionState["serverAnchor"]>,
    ) => {
      state.serverAnchor = action.payload;
    },
    setWindowState: (
      state,
      action: PayloadAction<SessionState["windowState"]>,
    ) => {
      state.windowState = action.payload;
    },
    togglePinMessage: (state, action: PayloadAction<number>) => {
      // Added by this fork (2c-5 UI / Option A): select-side pinning. The GUI owns
      // which turns are protected (pinned); the core only enforces the ceiling and
      // cuts pinned turns last (soft guarantee). Keys the pin by each message's
      // stable anchor key (message id), matching what selectWindowHistory keeps and
      // what the core receives as pinnedKeys, so a pin survives reloads and a core
      // re-prune. Pins the WHOLE turn: from the clicked assistant back through any
      // thinking/tool items until (and including) the most recent user prompt. This
      // is why agent-mode chains are covered: the assistant may be preceded by tool
      // outputs rather than the user directly, so walking back to the user guarantees
      // the user prompt is pinned too (previously only index-1 was, which could be a
      // tool, leaving the prompt unpinned). Creates a windowState if none exists yet.
      const index = action.payload;
      if (!state.history[index]) {
        return;
      }
      const keys: string[] = [];
      for (let i = index; i >= 0; i--) {
        const key = getAnchorKey(state.history[i].message);
        if (key !== undefined) {
          keys.push(key);
        }
        if (state.history[i].message.role === "user") {
          break; // include this user prompt, then stop the turn
        }
      }
      if (keys.length === 0) {
        return; // unkeyable turn cannot be pinned
      }
      const windowState = state.windowState ?? {
        includedIds: [],
        pinnedIds: [],
        nodeCosts: {},
      };
      const alreadyPinned = keys.every((key) =>
        windowState.pinnedIds.includes(key),
      );
      windowState.pinnedIds = alreadyPinned
        ? windowState.pinnedIds.filter((k) => !keys.includes(k))
        : [
            ...windowState.pinnedIds,
            ...keys.filter((k) => !windowState.pinnedIds.includes(k)),
          ];
      windowState.updatedAt = Date.now();
      state.windowState = windowState;
    },
    pruneIncompleteTrailingResponse: (state) => {
      // Added by this fork (resubmit fix): delete the LEAST possible. Used when a
      // request failed (server off mid-prompt, or connection lost mid-response).
      // It removes ONLY what is certainly incomplete at the tail of the current
      // turn, and never touches completed work:
      //   • an assistant with no content and no tool calls (empty)      -> incomplete
      //   • a text assistant with content but no finished prompt log and
      //     no executed tool call (truncated mid-stream)                -> incomplete
      //   • a thinking item still streaming (reasoning active / no endAt) -> incomplete
      // Anything COMPLETE is kept: a user, a tool result, an assistant that has a
      // prompt log (its stream finished normally) OR an assistant that produced a
      // non-generating tool call (the turn legitimately continues via tools).
      // We compute the last COMPLETE position ("boundary") and drop only assistant/
      // thinking items after it. This guarantees no prior good reply is ever eaten
      // (the old "resubmit" bug) and no completed turn is discarded.
      const history = state.history;
      // A reply is COMPLETE only if its stream finished normally. Continue attaches
      // promptLogs (via addPromptCompletionPair) EXCLUSIVELY on a normal completion,
      // so a prompt log is the ground-truth "this reply is whole" signal. An empty
      // assistant (server never reacted) and a truncated/errored assistant (connection
      // lost mid-stream) have NO prompt log → certainly incomplete. A tool result is
      // a complete applied action (kept). A user is a complete input (kept).
      const isCompleteAssistant = (
        item: ChatHistoryItemWithMessageId,
      ): boolean => (item.promptLogs?.length ?? 0) > 0;

      let boundary = -1;
      for (let i = 0; i < history.length; i++) {
        const role = history[i].message.role;
        if (role === "user" || role === "tool") {
          boundary = i;
        } else if (role === "assistant" && isCompleteAssistant(history[i])) {
          boundary = i;
        }
      }

      const kept: ChatHistoryItemWithMessageId[] = [];
      for (let i = 0; i < history.length; i++) {
        if (i <= boundary) {
          kept.push(history[i]);
          continue;
        }
        const role = history[i].message.role;
        // After the last complete point, drop assistant/thinking items (the failed
        // tail). A user/tool after boundary would mark a new complete point, but the
        // loop above already advanced the boundary for those, so we cannot get here
        // for them; being defensive, keep anything that is not a reply.
        if (role === "assistant" || role === "thinking") {
          continue;
        }
        kept.push(history[i]);
      }
      state.history = kept;
    },
  },
  selectors: {
    selectIsGatheringContext: (state) => {
      const curHistoryItem = state.history.at(-1);
      return curHistoryItem?.isGatheringContext || false;
    },
  },
  extraReducers: (builder) => {
    addPassthroughCases(builder, [streamResponseThunk]);
  },
});

function addPassthroughCases(
  builder: ActionReducerMapBuilder<SessionState>,
  thunks: AsyncThunk<any, any, any>[],
) {
  thunks.forEach((thunk) => {
    builder
      .addCase(thunk.fulfilled, (_state, _action) => {})
      .addCase(thunk.rejected, (_state, _action) => {})
      .addCase(thunk.pending, (_state, _action) => {});
  });
}

export const selectApplyStateByStreamId = createSelector(
  [
    (state: RootState) => state.session.codeBlockApplyStates.states,
    (_state: RootState, streamId?: string) => streamId,
  ],
  (states, streamId) => {
    return states.find((state) => state.streamId === streamId);
  },
);

export const selectApplyStateByToolCallId = createSelector(
  [
    (state: RootState) => state.session.codeBlockApplyStates.states,
    (_state: RootState, toolCallId?: string) => toolCallId,
  ],
  (states, toolCallId) => {
    if (toolCallId) {
      return states.find((state) => state.toolCallId === toolCallId);
    }
  },
);

export const {
  updateFileSymbols,
  setContextItemsAtIndex,
  addContextItemsAtIndex,
  setAppliedRulesAtIndex,
  setInactive,
  streamUpdate,
  newSession,
  updateSessionTitle,
  addHighlightedCode,
  addPromptCompletionPair,
  setActive,
  submitEditorAndInitAtIndex,
  truncateHistoryToMessage,
  updateHistoryItemAtIndex,
  clearDanglingMessages,
  setMainEditorContentTrigger,
  deleteMessage,
  deleteCompaction,
  setIsGatheringContext,
  resetNextCodeBlockToApplyIndex,
  updateApplyState,
  abortStream,
  setToolCallCalling,
  cancelToolCall,
  errorToolCall,
  acceptToolCall,
  setToolGenerated,
  updateToolCallOutput,
  setProcessedToolCallArgs,
  setMode,
  setIsSessionMetadataLoading,
  setAllSessionMetadata,
  addSessionMetadata,
  updateSessionMetadata,
  deleteSessionMetadata,
  setNewestToolbarPreviewForInput,
  setIsInEdit,
  setHasReasoningEnabled,
  setInlineErrorMessage,
  setIsPruned,
  setContextPercentage,
  setContextTokens,
  setTokenCalibration,
  setServerAnchor,
  setWindowState,
  togglePinMessage,
  pruneIncompleteTrailingResponse,
  setCompactionLoading,
} = sessionSlice.actions;

export const { selectIsGatheringContext } = sessionSlice.selectors;

export default sessionSlice.reducer;
