import * as fs from "fs";

import { BaseSessionMetadata, Session } from "../index.js";
import { ListHistoryOptions } from "../protocol/core.js";

import { NEW_SESSION_TITLE } from "./constants.js";
import {
  getSessionFilePath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths.js";
function safeParseArray<T>(
  value: string,
  errorMessage: string = "Error parsing array",
): T[] | undefined {
  try {
    return JSON.parse(value) as T[];
  } catch (e: any) {
    console.warn(`${errorMessage}: ${e}`);
    return undefined;
  }
}

/**
 * Strips the `prompt` field from every message's promptLogs before persisting.
 *
 * Each assistant message's promptLogs[n].prompt stores the *full* prompt that
 * was sent to the LLM at that turn (i.e. the entire accumulated history up to
 * that point). Persisting it makes session files grow quadratically with
 * conversation length - a long agent session reached 481 MB from promptLogs
 * alone (vs 3.7 MB of actual message content), which froze/crashed the webview
 * on reload.
 *
 * The `prompt` field is not read by the GUI: the only consumers
 * (ContextStatus.tsx, ResponseActions.tsx) read `usage` and `modelTitle`, and
 * the full prompt is already written separately to the Continue Console log
 * (`getPromptLogsPath()` via LLMLogFormatter). So it is safe to drop from the
 * persisted session.
 *
 * Returns a shallow-copied history; the input objects are not mutated.
 */
function stripPromptLogsPrompt(
  history: Session["history"],
): Session["history"] {
  return history.map((item) => {
    if (!item.promptLogs || !item.promptLogs.length) {
      return item;
    }
    const hadPrompt = item.promptLogs.some((log) => log.prompt !== undefined);
    if (!hadPrompt) {
      return item;
    }
    return {
      ...item,
      promptLogs: item.promptLogs.map(({ prompt, ...rest }) => rest),
    };
  });
}

export class HistoryManager {
  list(options: ListHistoryOptions): BaseSessionMetadata[] {
    const filepath = getSessionsListPath();
    if (!fs.existsSync(filepath)) {
      return [];
    }
    const content = fs.readFileSync(filepath, "utf8");

    let sessions = safeParseArray<BaseSessionMetadata>(content) ?? [];
    sessions = sessions
      .filter((session: any) => {
        // Filter out old format
        return typeof session.session_id !== "string";
        // Reverse to show newest first; sessions.json is chronological by creation
      })
      .reverse();

    // Filter by workspace directory if provided
    if (options.workspaceDirectory) {
      const target = options.workspaceDirectory.toLowerCase();
      sessions = sessions.filter(
        (session) =>
          typeof session.workspaceDirectory === "string" &&
          session.workspaceDirectory.toLowerCase() === target,
      );
    }

    // Apply limit and offset
    if (options.limit) {
      const offset = options.offset || 0;
      sessions = sessions.slice(offset, offset + options.limit);
    }

    return sessions;
  }

  delete(sessionId: string) {
    // Delete a session
    const sessionFile = getSessionFilePath(sessionId);
    if (!fs.existsSync(sessionFile)) {
      throw new Error(`Session file ${sessionFile} does not exist`);
    }
    fs.unlinkSync(sessionFile);

    // Read and update the sessions list
    const sessionsListFile = getSessionsListPath();
    const sessionsListRaw = fs.readFileSync(sessionsListFile, "utf-8");
    let sessionsList =
      safeParseArray<BaseSessionMetadata>(
        sessionsListRaw,
        "Error parsing sessions.json",
      ) ?? [];

    sessionsList = sessionsList.filter(
      (session) => session.sessionId !== sessionId,
    );

    fs.writeFileSync(
      sessionsListFile,
      JSON.stringify(sessionsList, undefined, 2),
    );
  }

  clearAll() {
    fs.rmSync(getSessionsFolderPath(), { recursive: true, force: true });
  }

  load(sessionId: string): Session {
    try {
      const sessionFile = getSessionFilePath(sessionId);
      if (!fs.existsSync(sessionFile)) {
        throw new Error(`Session file ${sessionFile} does not exist`);
      }
      const session: Session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      session.sessionId = sessionId;
      return session;
    } catch (e) {
      console.log(`Error loading session: ${e}`);
      return {
        history: [],
        title: NEW_SESSION_TITLE,
        workspaceDirectory: "",
        sessionId: sessionId,
      };
    }
  }

  save(session: Session) {
    // Save the main session json file
    // Explicitely rewriting here to influence the written key order in the file!
    // e.g. id at the top, history next, etc.
    const orderedSession: Session = {
      sessionId: session.sessionId,
      title: session.title,
      workspaceDirectory: session.workspaceDirectory,
      // promptLogs[].prompt is the full prompt sent at each turn, which grows
      // quadratically with conversation length and crashed the webview on reload.
      // It is redundant with the Continue Console log and unused by the GUI, so
      // it is stripped here. See stripPromptLogsPrompt for the full rationale.
      history: stripPromptLogsPrompt(session.history),
    };
    if (session.mode) {
      orderedSession.mode = session.mode;
    }
    if (session.chatModelTitle !== undefined) {
      orderedSession.chatModelTitle = session.chatModelTitle;
    }
    if (session.usage !== undefined) {
      orderedSession.usage = session.usage;
    }
    // Added by this fork: persist the context-accounting snapshot (see Session)
    // so the context bar/tooltip survives a session reload. Without these the
    // explicit rebuild above would silently drop them before JSON.stringify.
    if (session.contextTokens !== undefined) {
      orderedSession.contextTokens = session.contextTokens;
    }
    if (session.contextPercentage !== undefined) {
      orderedSession.contextPercentage = session.contextPercentage;
    }
    if (session.tokenCalibration !== undefined) {
      orderedSession.tokenCalibration = session.tokenCalibration;
    }

    fs.writeFileSync(
      getSessionFilePath(session.sessionId),
      JSON.stringify(orderedSession, undefined, 2),
    );

    // Read and update the sessions list
    const sessionsListFilePath = getSessionsListPath();
    try {
      const rawSessionsList = fs.readFileSync(sessionsListFilePath, "utf-8");

      let sessionsList: BaseSessionMetadata[];
      try {
        sessionsList = JSON.parse(rawSessionsList);
      } catch (e) {
        if (rawSessionsList.trim() === "") {
          fs.writeFileSync(sessionsListFilePath, JSON.stringify([]));
          sessionsList = [];
        } else {
          throw e;
        }
      }

      let found = false;
      const messageCount = session.history.filter(
        (item) => item.message.role === "assistant",
      ).length;
      for (const sessionMetadata of sessionsList) {
        if (sessionMetadata.sessionId === session.sessionId) {
          sessionMetadata.title = session.title;
          sessionMetadata.workspaceDirectory = session.workspaceDirectory;
          sessionMetadata.messageCount = messageCount;
          found = true;
          break;
        }
      }

      if (!found) {
        const sessionMetadata: BaseSessionMetadata = {
          sessionId: session.sessionId,
          title: session.title,
          dateCreated: String(Date.now()),
          workspaceDirectory: session.workspaceDirectory,
          messageCount,
        };
        sessionsList.push(sessionMetadata);
      }

      fs.writeFileSync(
        sessionsListFilePath,
        JSON.stringify(sessionsList, undefined, 2),
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `It looks like there is a JSON formatting error in your sessions.json file (${sessionsListFilePath}). Please fix this before creating a new session.`,
        );
      }
      throw new Error(
        `It looks like there is a validation error in your sessions.json file (${sessionsListFilePath}). Please fix this before creating a new session. Error: ${error}`,
      );
    }
  }
}

const historyManager = new HistoryManager();

export default historyManager;
