import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import { InputModifiers } from "core";
import StreamErrorDialog from "../../pages/gui/StreamError";
import {
  abortStream,
  pruneIncompleteTrailingResponse,
  setInactive,
} from "../slices/sessionSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { ThunkApiType } from "../store";
import { streamNormalInput } from "./streamNormalInput";
import { streamResponseThunk } from "./streamResponse";

/**
 * Added by this fork: the "Resubmit last message" action, as resume-not-restart.
 *
 * 1. pruneIncompleteTrailingResponse() first removes ONLY the certainly-incomplete
 *    reply at the tail (an empty or truncated assistant - no prompt log). Completed
 *    work (users, applied tools, finished replies) is never touched, so repeated
 *    resubmits can never eat a good reply (the original truncating bug).
 * 2. streamNormalInput() then continues from the surviving history: it rebuilds the
 *    request from the current history (ending at the user prompt, or at already
 *    applied tool results) and asks the model to carry on. Tools already run are
 *    plain history and are NOT re-executed.
 *
 * On failure of CASE A we deliberately DON'T use streamThunkWrapper: its
 * cancelStream -> clearDanglingMessages would DROP the trailing user prompt when
 * history ends on a bare user, losing the very thing we want to continue from. We
 * only un-stick the streaming state (setInactive + abortStream) and re-show the
 * dialog, so the error keeps resurfacing in a loop until it succeeds, without data
 * loss.
 *
 * THEN, branch on where the surviving history actually ENDS, because it differs by
 * how the request failed:
 *
 *  CASE A - server died DURING a response (e.g. cut mid read-repomap). The failed
 *    turn's user prompt (or an applied tool result) is still in history, so history
 *    legitimately ends on a user/tool. streamNormalInput() continues from that
 *    surviving history; already-applied tools are plain history, NOT re-executed.
 *
 *  CASE B - server was ALREADY OFF when the prompt was sent. The original send's
 *    failure path (cancelStream -> clearDanglingMessages) removed the dangling user
 *    and parked the prompt back in the input box, so history ends on the PREVIOUS
 *    assistant. Resuming there would make the model answer its own last reply
 *    (observed). Instead we re-send the parked prompt as a normal new send via
 *    streamResponseThunk, which re-appends it to history (so it is answered) and
 *    loops on error through its own wrapper. The editor content is supplied by the
 *    caller (the main input box holding the parked prompt), and clearEditor mirrors
 *    the normal-send path (Chat.sendInput clears the editor on submit): after a
 *    successful re-send the prompt is now in history, so the input box must clear.
 *    If the re-send fails again, streamThunkWrapper's cancelStream ->
 *    clearDanglingMessages re-parks the prompt back into the editor via
 *    mainEditorContentTrigger, so the retry loop keeps the prompt available.
 */
export const resubmitLastMessage = createAsyncThunk<
  void,
  {
    editorState?: JSONContent;
    modifiers?: InputModifiers;
    clearEditor?: () => void;
  },
  ThunkApiType
>(
  "chat/resubmitLastMessage",
  async ({ editorState, modifiers, clearEditor }, { dispatch, getState }) => {
    dispatch(pruneIncompleteTrailingResponse());

    const last = getState().session.history.at(-1);
    const endsOnUserOrTool =
      !!last && (last.message.role === "user" || last.message.role === "tool");

    if (endsOnUserOrTool) {
      // CASE A: continue from the surviving history.
      try {
        unwrapResult(await dispatch(streamNormalInput({})));
      } catch (e) {
        dispatch(setInactive());
        dispatch(abortStream());
        dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
        dispatch(setShowDialog(true));
      }
      return;
    }

    // CASE B: re-send the parked prompt as a fresh send so it enters history.
    if (!editorState) {
      // Nothing to re-send (input box empty): keep an error visible.
      dispatch(setInactive());
      dispatch(abortStream());
      dispatch(
        setDialogMessage(
          <StreamErrorDialog error={new Error("No message to resubmit.")} />,
        ),
      );
      dispatch(setShowDialog(true));
      return;
    }
    // Fire the normal-send flow (which appends the user + loops on error through
    // its wrapper), then clear the input box - identical to Chat.sendInput. If this
    // send fails, the prompt is re-parked by clearDanglingMessages, not lost.
    void dispatch(
      streamResponseThunk({
        editorState,
        modifiers: modifiers ?? { noContext: true, useCodebase: false },
      }),
    );
    clearEditor?.();
  },
);
