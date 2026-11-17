import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { LLMFullCompletionOptions, ModelDescription } from "core";
import { getRuleId } from "core/llm/rules/getSystemMessageWithRules";
import { ToCoreProtocol } from "core/protocol";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import { selectActiveTools } from "../selectors/selectActiveTools";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  abortStream,
  addPromptCompletionPair,
  errorToolCall,
  setActive,
  setAppliedRulesAtIndex,
  setContextPercentage,
  setContextTokens,
  setTokenCalibration,
  setServerAnchor,
  setWindowState,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
  setToolGenerated,
  streamUpdate,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { selectWindowHistory } from "../util/selectWindowHistory";

import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { getAnchorKey } from "core/llm/messages";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { interceptSystemToolCalls } from "core/tools/systemMessageTools/interceptSystemToolCalls";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";

import {
  selectCurrentToolCalls,
  selectPendingToolCalls,
} from "../selectors/selectToolCalls";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";
import { callToolById } from "./callToolById";
import { evaluateToolPolicies } from "./evaluateToolPolicies";
import { preprocessToolCalls } from "./preprocessToolCallArgs";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

/**
 * Builds completion options with reasoning configuration based on session state and model capabilities.
 *
 * @param baseOptions - Base completion options to extend
 * @param hasReasoningEnabled - Whether reasoning is enabled in the session
 * @param model - The selected model with provider and completion options
 * @returns Completion options with reasoning configuration
 */
/**
 * Added by this fork: fingerprint of the NON-NEGOTIABLE parts of a chat request
 * (system message text + active tool names). The incremental server anchor is
 * only trusted while this fingerprint is unchanged, because the server's reported
 * prompt_tokens includes those fixed costs. A different system message or tool
 * set invalidates the baseline → full local estimate (safe fallback).
 */
function computeBaseSignature(
  systemMessageContent: string | undefined,
  activeTools: { function: { name: string } }[],
): string {
  const systemHash = systemMessageContent ?? "";
  const toolNames = activeTools.map((t) => t.function.name).sort();
  // Cheap, collision-resistant enough for an invalidation guard.
  return `${systemHash.length}:${toolNames.join(",")}`;
}

function buildReasoningCompletionOptions(
  baseOptions: LLMFullCompletionOptions,
  hasReasoningEnabled: boolean | undefined,
  model: ModelDescription,
): LLMFullCompletionOptions {
  if (hasReasoningEnabled === undefined) {
    return baseOptions;
  }

  const reasoningOptions: LLMFullCompletionOptions = {
    ...baseOptions,
    reasoning: !!hasReasoningEnabled,
  };

  // Add reasoning budget tokens if reasoning is enabled and provider supports it
  if (hasReasoningEnabled && model.underlyingProviderName !== "ollama") {
    // Ollama doesn't support limiting reasoning tokens at this point
    reasoningOptions.reasoningBudgetTokens =
      model.completionOptions?.reasoningBudgetTokens ?? 2048;
  }

  return reasoningOptions;
}

export const streamNormalInput = createAsyncThunk<
  void,
  {
    legacySlashCommandData?: ToCoreProtocol["llm/streamChat"][0]["legacySlashCommandData"];
    depth?: number;
  },
  ThunkApiType
>(
  "chat/streamNormalInput",
  async (
    { legacySlashCommandData, depth = 0 },
    { dispatch, extra, getState },
  ) => {
    if (process.env.NODE_ENV === "test" && depth > 50) {
      const message = `Max stream depth of ${50} reached in test`;
      console.error(message, JSON.stringify(getState(), null, 2));
      throw new Error(message);
    }
    const state = getState();
    const selectedChatModel = selectSelectedChatModel(state);

    if (!selectedChatModel) {
      throw new Error("No chat model selected");
    }

    // Get tools and apply model-level overrides (disabled, description, etc.)
    let activeTools = selectActiveTools(state);
    if (selectedChatModel.toolOverrides?.length) {
      const { tools: overriddenTools, errors } = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      );
      activeTools = overriddenTools;
      for (const error of errors) {
        if (!error.fatal) {
          console.warn(`Tool override warning: ${error.message}`);
        }
      }
    }

    // Use the centralized selector to determine if system message tools should be used
    const useNativeTools = state.config.config.experimental
      ?.onlyUseSystemMessageTools
      ? false
      : modelSupportsNativeTools(selectedChatModel);
    const systemToolsFramework = !useNativeTools
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;

    // Construct completion options
    let completionOptions: LLMFullCompletionOptions = {};
    if (useNativeTools && activeTools.length > 0) {
      completionOptions = {
        tools: activeTools,
      };
    }

    completionOptions = buildReasoningCompletionOptions(
      completionOptions,
      state.session.hasReasoningEnabled,
      selectedChatModel,
    );

    // Construct messages (excluding system message)
    const baseSystemMessage = getBaseSystemMessage(
      state.session.mode,
      selectedChatModel,
      activeTools,
    );

    const systemMessage = systemToolsFramework
      ? addSystemMessageToolsToSystemMessage(
          systemToolsFramework,
          baseSystemMessage,
          activeTools,
        )
      : baseSystemMessage;

    // Added by this fork: how we account for tokens when pruning. Read up front
    // because it decides whether message ids are threaded to the core below.
    const contextTokenMode =
      state.config.config.ui?.contextTokenMode ?? "local";
    const isCalibration = contextTokenMode === "calibration";
    const isIncremental = contextTokenMode === "incremental";

    // Added by this fork: incremental server-anchored baseline + GUI context
    // window. Compute the fingerprint of the NON-NEGOTIABLE parts (system message
    // text + active tool names) up front, because it gates both the trusted server
    // baseline and the window filter below. If system/tools/model match the last
    // send, the previous server prompt_tokens still covers the fixed costs, so it
    // is safe to trust that baseline, keep only the turns the core actually kept,
    // and add the genuinely-new ones. If they changed, the baseline is stale → we
    // send no baseline AND the full history, and the core falls back to a full
    // local estimate (safe).
    const baseSignature = computeBaseSignature(systemMessage, activeTools);
    const anchor = state.session.serverAnchor;
    const anchorIsValid =
      isIncremental &&
      !!anchor &&
      anchor.modelKey === selectedChatModel.model &&
      anchor.baseSignature === baseSignature;

    // Added by this fork: in incremental mode only, keep each message's stable
    // client-side id on the history we compile. The core echoes those ids back on
    // compiledChatMessages so the server anchor and the window can record which
    // turns it kept. Providers only serialize explicit fields, so ids never reach
    // the API. When a valid window exists, we ALSO drop turns the core cut last
    // turn (never re-introduce them — re-sending cut turns is what created the
    // phantom re-count), keeping the active exchange always. In the other modes
    // ids are stripped exactly as before, keeping the payload identical.
    const historyForCompile = isIncremental
      ? selectWindowHistory(
          state.session.history,
          anchorIsValid ? state.session.windowState : undefined,
        )
      : state.session.history.map((item) => {
          const { id, ...messageWithoutId } = item.message;
          return { ...item, message: messageWithoutId };
        });

    const { messages, appliedRules, appliedRuleIndex } = constructMessages(
      historyForCompile,
      systemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
      systemToolsFramework,
    );

    // TODO parallel tool calls will cause issues with this
    // because there will be multiple tool messages, so which one should have applied rules?
    dispatch(
      setAppliedRulesAtIndex({
        index: appliedRuleIndex,
        appliedRules: appliedRules,
      }),
    );

    dispatch(setActive());
    dispatch(setInlineErrorMessage(undefined));

    // Added by this fork: measured token calibration. When the setting is on
    // and the previous request measured a calibration factor for the *same*
    // model, reuse it so this request's pruning budget is based on the server's
    // real token count instead of Continue's inflated local estimate. A model
    // switch (different tokenizer) or a fresh session yields undefined → core
    // falls back to its local estimate (factor 1).
    const existingCalibration = state.session.tokenCalibration;
    const calibrationFactor =
      isCalibration &&
      existingCalibration &&
      existingCalibration.modelKey === selectedChatModel.model
        ? existingCalibration.factor
        : undefined;

    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages,
      options: completionOptions,
      calibrationFactor,
      serverBaseTokens: anchorIsValid ? anchor.promptTokens : undefined,
      anchoredKeys: anchorIsValid ? anchor.anchoredKeys : undefined,
      // Added by this fork (2c-5): pass the GUI-pinned ids so the core's
      // hard guard cuts non-pinned turns first and only force-cuts pinned ones
      // last. Omitted (undefined) when nothing is pinned, so the payload stays
      // byte-identical to before for sessions without pins (matches the
      // existing anchoredKeys/serverBaseTokens undefined pattern).
      pinnedKeys: state.session.windowState?.pinnedIds?.length
        ? state.session.windowState.pinnedIds
        : undefined,
    });

    if (precompiledRes.status === "error") {
      if (precompiledRes.error.includes("Not enough context")) {
        dispatch(setInlineErrorMessage("out-of-context"));
        dispatch(setInactive());
        return;
      } else {
        throw new Error(precompiledRes.error);
      }
    }

    const {
      compiledChatMessages,
      didPrune,
      contextPercentage,
      inputTokens,
      availableTokens,
      contextLength,
      breakdown,
    } = precompiledRes.content;

    dispatch(setIsPruned(didPrune));
    dispatch(setContextPercentage(contextPercentage));
    // Added by this fork: surface absolute token counts in the toolbar.
    // Only dispatched when core reports the optional fields (this fork's core
    // always does). When absent (e.g. mocks / older core) we leave the field
    // untouched: it is reset to undefined by newSession/deleteMessage/compact.
    if (
      inputTokens !== undefined &&
      availableTokens !== undefined &&
      contextLength !== undefined
    ) {
      dispatch(
        setContextTokens({
          used: inputTokens,
          available: availableTokens,
          max: contextLength,
          breakdown,
        }),
      );
    }

    const start = Date.now();
    const streamAborter = state.session.streamAborter;
    try {
      let gen = extra.ideMessenger.llmStreamChat(
        {
          completionOptions,
          title: selectedChatModel.title,
          messages: compiledChatMessages,
          legacySlashCommandData,
          messageOptions: { precompiled: true },
        },
        streamAborter.signal,
      );
      if (systemToolsFramework && activeTools.length > 0) {
        gen = interceptSystemToolCalls(
          gen,
          streamAborter,
          systemToolsFramework,
        );
      }

      let next = await gen.next();
      while (!next.done) {
        if (!getState().session.isStreaming) {
          dispatch(abortStream());
          break;
        }

        dispatch(streamUpdate(next.value));
        next = await gen.next();
      }

      // Attach prompt log and end thinking for reasoning models
      if (next.done && next.value) {
        dispatch(addPromptCompletionPair([next.value]));

        // Added by this fork: measure calibration from this request's
        // server-reported usage. Core already applied `calibrationFactor` to
        // its per-message estimates, so `contextTokens.used` is the CALIBRATED
        // estimate for the exact set that was sent. The server's prompt_tokens
        // covers that same set, so the residual (real / calibrated) is folded
        // multiplicatively into the stored factor:
        //   F_new = F_old × real / (E_raw × F_old) = real / E_raw
        // i.e. the full server/local ratio for the *uncalibrated* estimate,
        // re-derived at the current context size each request (so a
        // non-linear tokenizer divergence is tracked, not frozen at one value).
        const serverUsage = next.value.usage;
        const calibratedUsed = getState().session.contextTokens?.used;
        if (
          isCalibration &&
          serverUsage?.promptTokens &&
          calibratedUsed &&
          calibratedUsed > 0
        ) {
          const residual = serverUsage.promptTokens / calibratedUsed;
          if (Number.isFinite(residual)) {
            const nextFactor = (calibrationFactor ?? 1) * residual;
            dispatch(
              setTokenCalibration({
                factor: Math.min(1.5, Math.max(0.33, nextFactor)),
                modelKey: selectedChatModel.model,
              }),
            );
          }
        }

        // Added by this fork: capture the server anchor for incremental mode.
        // The server reported prompt_tokens for exactly `compiledChatMessages`
        // (the set we just sent). The core echoes each message's anchor key back,
        // so we record those keys as "already counted" — the next request treats
        // these specific messages as known and only estimates newly added ones.
        // Keying by id/toolCallId (not a count) survives the core re-pruning its
        // older turns. baseSignature ties the baseline to the system+tool set so a
        // later change invalidates it. Only captured when the server reported usage.
        if (isIncremental && serverUsage?.promptTokens) {
          const anchoredKeys = compiledChatMessages
            .map((m) => getAnchorKey(m))
            .filter((key): key is string => typeof key === "string");
          dispatch(
            setServerAnchor({
              promptTokens: serverUsage.promptTokens,
              anchoredKeys,
              baseSignature,
              modelKey: selectedChatModel.model,
            }),
          );

          // Added by this fork (2c-4): record the GUI-owned window so the NEXT
          // incremental request re-sends only what the core actually kept plus the
          // genuinely-new turns, and never re-introduces a turn the core cut this
          // turn. includedIds = every anchor key the core kept in the compiled set
          // (it may have dropped older turns via the hard guard); knownIds = every
          // key we were aware of when sending. knownIds \ includedIds is precisely
          // the set of cut turns to suppress next turn. nodeCosts merges the core's
          // per-node counts so the GUI can budget a window later (2c) without a
          // tokenizer. This is the fix for the phantom delta that pinned the bar at
          // ~100% despite a valid server anchor.
          const previousWindow = getState().session.windowState;
          const nodeCosts: Record<string, number> = {
            ...(previousWindow?.nodeCosts ?? {}),
          };
          for (const { key, tokens } of precompiledRes.content.nodeCosts ??
            []) {
            nodeCosts[key] = tokens;
          }
          const knownKeys = new Set<string>(previousWindow?.knownIds ?? []);
          for (const item of historyForCompile) {
            const key = getAnchorKey(item.message);
            if (typeof key === "string") {
              knownKeys.add(key);
            }
          }
          dispatch(
            setWindowState({
              includedIds: anchoredKeys,
              pinnedIds: previousWindow?.pinnedIds ?? [],
              knownIds: Array.from(knownKeys),
              nodeCosts,
              baseSignature,
              modelKey: selectedChatModel.model,
              updatedAt: Date.now(),
            }),
          );
        }

        try {
          extra.ideMessenger.post("devdata/log", {
            name: "chatInteraction",
            data: {
              // prompt may be absent (no longer persisted in some paths); the
              // telemetry schema expects a string, so fall back to empty.
              prompt: next.value.prompt ?? "",
              completion: next.value.completion,
              modelProvider: selectedChatModel.underlyingProviderName,
              modelName: selectedChatModel.title,
              modelTitle: selectedChatModel.title,
              sessionId: state.session.id,
              ...(!!activeTools.length && {
                tools: activeTools.map((tool) => tool.function.name),
              }),
              ...(appliedRules.length > 0 && {
                rules: appliedRules.map((rule) => ({
                  id: getRuleId(rule),
                  slug: rule.slug,
                })),
              }),
            },
          });
        } catch (e) {
          console.error("Failed to send dev data interaction log", e);
        }
      }
    } catch (e) {
      const toolCallsToCancel = selectCurrentToolCalls(getState());
      if (
        toolCallsToCancel.length > 0 &&
        e instanceof Error &&
        e.message.toLowerCase().includes("premature close")
      ) {
        for (const tc of toolCallsToCancel) {
          dispatch(
            errorToolCall({
              toolCallId: tc.toolCallId,
              output: [
                {
                  name: "Tool Call Error",
                  description: "Premature Close",
                  content: `"Premature Close" error: this tool call was aborted mid-stream because the arguments took too long to stream or there were network issues. Please re-attempt by breaking the operation into smaller chunks or trying something else`,
                  icon: "problems",
                },
              ],
            }),
          );
        }
      } else {
        throw e;
      }
    }

    // Tool call sequence:
    // 1. Mark generating tool calls as generated
    const state1 = getState();
    if (streamAborter.signal.aborted || !state1.session.isStreaming) {
      return;
    }
    const originalToolCalls = selectCurrentToolCalls(state1);
    const generatingCalls = originalToolCalls.filter(
      (tc) => tc.status === "generating",
    );
    for (const { toolCallId } of generatingCalls) {
      dispatch(
        setToolGenerated({
          toolCallId,
          tools: state1.config.config.tools,
        }),
      );
    }

    // 2. Pre-process args to catch invalid args before checking policies
    const state2 = getState();
    if (streamAborter.signal.aborted || !state2.session.isStreaming) {
      return;
    }
    const generatedCalls2 = selectPendingToolCalls(state2);
    await preprocessToolCalls(dispatch, extra.ideMessenger, generatedCalls2);

    // 3. Security check: evaluate updated policies based on args
    const state3 = getState();
    if (streamAborter.signal.aborted || !state3.session.isStreaming) {
      return;
    }
    const generatedCalls3 = selectPendingToolCalls(state3);
    const toolPolicies = state3.ui.toolSettings;
    const policies = await evaluateToolPolicies(
      dispatch,
      extra.ideMessenger,
      activeTools,
      generatedCalls3,
      toolPolicies,
    );
    const autoApprovedPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithoutPermission",
    );
    const needsApprovalPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithPermission",
    );

    // 4. Execute remaining tool calls
    if (originalToolCalls.length === 0) {
      dispatch(setInactive());
    } else if (needsApprovalPolicies.length > 0) {
      const builtInReadonlyAutoApproved = autoApprovedPolicies.filter(
        ({ toolCallState }) =>
          toolCallState.tool?.group === BUILT_IN_GROUP_NAME &&
          toolCallState.tool?.readonly,
      );

      if (builtInReadonlyAutoApproved.length > 0) {
        const state4 = getState();
        if (streamAborter.signal.aborted || !state4.session.isStreaming) {
          return;
        }
        await Promise.all(
          builtInReadonlyAutoApproved.map(async ({ toolCallState }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId: toolCallState.toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                }),
              ),
            );
          }),
        );
      }

      dispatch(setInactive());
    } else {
      // auto stream cases increase thunk depth by 1 for debugging
      const state4 = getState();
      const generatedCalls4 = selectPendingToolCalls(state4);
      if (streamAborter.signal.aborted || !state4.session.isStreaming) {
        return;
      }
      if (generatedCalls4.length > 0) {
        await Promise.all(
          generatedCalls4.map(async ({ toolCallId }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                }),
              ),
            );
          }),
        );
      } else {
        for (const { toolCallId } of originalToolCalls) {
          unwrapResult(
            await dispatch(
              streamResponseAfterToolCall({
                toolCallId,
                depth: depth + 1,
              }),
            ),
          );
        }
      }
    }
  },
);
