import { ChatMessage } from "..";

export function messageHasToolCalls(msg: ChatMessage): boolean {
  return msg.role === "assistant" && !!msg.toolCalls;
}

export function messageIsEmpty(message: ChatMessage): boolean {
  if (typeof message.content === "string") {
    return message.content.trim() === "";
  }
  if (Array.isArray(message.content)) {
    return message.content.every(
      (item) => item.type === "text" && item.text?.trim() === "",
    );
  }
  return false;
}

// some providers don't support empty messages
export function addSpaceToAnyEmptyMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.map((message) => {
    if (messageIsEmpty(message)) {
      message.content = " ";
    }
    return message;
  });
}

export function isUserOrToolMsg(msg: ChatMessage | undefined): boolean {
  if (!msg) {
    return false;
  }
  return msg.role === "user" || msg.role === "tool";
}

export function isToolMessageForId(
  msg: ChatMessage | undefined,
  toolCallId: string,
): boolean {
  return !!msg && msg.role === "tool" && msg.toolCallId === toolCallId;
}

export function messageHasToolCallId(
  msg: ChatMessage | undefined,
  toolCallId: string,
): boolean {
  return (
    !!msg &&
    msg.role === "assistant" &&
    !!msg.toolCalls?.find((call) => call.id === toolCallId)
  );
}

export function chatMessageIsEmpty(message: ChatMessage): boolean {
  switch (message.role) {
    case "system":
    case "user":
      return (
        typeof message.content === "string" && message.content.trim() === ""
      );
    case "assistant":
      return (
        typeof message.content === "string" &&
        message.content.trim() === "" &&
        !message.toolCalls
      );
    case "thinking":
    case "tool":
      return false;
  }
}

/**
 * Added by this fork: a stable identity for a chat message, used by the
 * incremental context-accounting path to decide which messages the server has
 * already token-counted (and must therefore NOT be re-estimated locally).
 *
 * - A message carrying a client-side id is keyed by that id (set for user,
 *   assistant and thinking messages, which constructMessages carries through).
 * - Tool messages are rebuilt fresh every turn (no id), but their `toolCallId`
 *   is stable across turns, so they are keyed by `tool:<toolCallId>`. Without
 *   this, agent-mode tool messages already counted by the server would be
 *   double-counted on top of the server baseline, negating the whole benefit.
 * - The system message has no id by design and is intentionally left keyless:
 *   it is part of the server baseline and is never re-counted as a delta.
 *
 * Returns undefined for messages that cannot be keyed (system). Callers treat an
 * unkeyable message as "not a delta" only when a server baseline is present.
 */
export function getAnchorKey(message: ChatMessage): string | undefined {
  if (typeof message.id === "string" && message.id.length > 0) {
    return message.id;
  }
  if (message.role === "tool" && typeof message.toolCallId === "string") {
    return `tool:${message.toolCallId}`;
  }
  return undefined;
}
