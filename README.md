<h1 align="center">Continue</h1>

<p align="center">Pioneering open-source coding agent</p>

<div align="center">

<a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" /></a>
<a href="https://docs.continue.dev"><img src="https://img.shields.io/badge/Docs-docs.continue.dev-blue" /></a>
<a href="https://github.com/continuedev/continue/releases"><img src="https://img.shields.io/badge/Changelog-GitHub_Releases-blue" /></a>

</div>

<p align="center">
  <img src="media/github-readme.png" alt="Banner" />
</p>

## Fork: Continue(d)

This is a personal fork of [Continue](https://github.com/continuedev/continue), used as my day-to-day VS Code coding agent. It tracks upstream and layers on the UI fixes and quality-of-life improvements I need while working — see [Features](#features) for the current list.

### Features

| Feature                      | Description                                                                                                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🛠️ **MCP Tool Args Display** | A toggle icon (code brackets) next to each tool call shows the tool's arguments inline, e.g. `SearchWeb(query: "react hooks", url: "https://...")`. Makes it easy to verify what the LLM is about to do before approving.                                   |
| 📤 **Tool Output Display**   | A toggle icon (document) next to each tool call shows the full response received from the tool (web search results, command output, ...). Makes it easy to analyze/debug the agent's behavior after execution.                                              |
| 📊 **Context & Token Count** | The context indicator is now a clickable button showing absolute usage (e.g. `1,240 / 128,000 tokens (1%)`). Clicking it reveals a per-category breakdown — System / Tools / History / Last message — alongside the existing Compact / New session actions. |
| 🕒 **Message Timestamp**     | Each completed assistant response shows a small info icon with a compact timestamp (`YYMMDD-HH:MM`), left-aligned in the response actions row. Hovering reveals the full timestamp, the model used, and (when the provider reports it) in/out token counts. |
| ↔️ **Chat Width Fix**        | Long tool calls (commands, file paths, URLs with no spaces) no longer force the chat wider than the panel, and the args/output/truncate icons stay visible when the panel is narrowed.                                                                      |

> All changes are purely UI enhancements — the underlying tool calls and MCP protocol are not modified.

### Changelog

#### 1.4.0-preview.3

Based on upstream `continuedev/continue` (package version 1.3.40).

- **Added** — Context token counts. `compileChatMessages` now reports absolute token counts (`inputTokens` / `availableTokens` / `contextLength`) and a per-category breakdown (`system` / `tools` / `history` / `lastSequence`). These flow through the Redux session slice and are surfaced in the input toolbar as a clickable button (e.g. `1,240 / 128,000`) with a breakdown tooltip, replacing the bare percentage bar. The new `CompiledMessagesResult` fields are optional, so existing mocks and tests that build the object by hand keep compiling. Files: `core/llm/countTokens.ts`, `core/index.d.ts`, `gui/src/redux/slices/sessionSlice.ts`, `gui/src/redux/thunks/streamNormalInput.ts`, `gui/src/components/mainInput/ContextStatus.tsx`.
- **Added** — Message timestamps. `ChatHistoryItem` gained an optional `timestamp` (epoch ms) recorded at every point where a history item is created (send, resubmit, truncate, streaming). Each completed assistant response now shows a left-aligned info icon with a compact `YYMMDD-HH:MM` label; hovering reveals the full timestamp, the model used (`promptLogs`), and in/out token counts when the provider reports them. The field is optional, so sessions persisted before this change are unaffected (older messages simply show no timestamp). Files: `core/index.d.ts`, `gui/src/redux/slices/sessionSlice.ts`, `gui/src/components/StepContainer/ResponseActions.tsx`. Tests: added a `stripHistoryTimestamps` helper (`gui/src/util/test/mockStore.ts`) so the exact-state snapshots in `streamResponse*.test.ts` stay deterministic.
- **Added** — Server-reported token usage (diagnosis). OpenAI-compatible servers (strata / llama.cpp / LM Studio) already report `usage` on the final stream chunk (`stream_options.include_usage`), but Continue was discarding it. `fromChatCompletionChunk` now normalises the raw usage (`prompt_tokens` → `promptTokens`) into an empty assistant carrier, `streamChat` exposes it via `PromptLog.usage`, and `streamUpdate` skips the empty carrier so no phantom bubble is created. The context button tooltip now shows `Server input / Server output / Estimate gap` next to Continue's local estimate, making the divergence measurable (observed as a non-linear 1.25×–1.65× ratio). This is the foundation for server-referenced incremental token counting. All `usage` fields are optional, so mocks and tests keep compiling. Files: `core/index.d.ts`, `core/llm/openaiTypeConverters.ts`, `core/llm/index.ts`, `gui/src/redux/slices/sessionSlice.ts`, `gui/src/components/mainInput/ContextStatus.tsx`.
- **Fixed** — Per-message token counts not showing. The message info tooltip read `message.usage`, which most providers never populate; it now reads `promptLogs.at(-1).usage` (the field the core actually fills), falling back to `message.usage`. (`ResponseActions.tsx`)
- **Fixed** — React error #310 ("Rendered more hooks than during the previous render") when sending a prompt. A `useMemo` had been added after `ContextStatus`'s conditional `return null` guards, changing the hook count between renders. Moved it next to the other top-level hooks, before any early return. (`ContextStatus.tsx`)
- **Fixed** — Large agent sessions crashing the webview on reopen. Each assistant message's `promptLogs[].prompt` stored the _full_ prompt sent at that turn (i.e. the entire accumulated history up to that point), so session files grew quadratically with conversation length - one session reached ~458 MB (vs ~3 MB of actual message content), which froze/crashed the window on reload (`CodeWindow unresponsive`). `HistoryManager.save` now strips `promptLogs[].prompt` before writing (`stripPromptLogsPrompt`), and `PromptLog.prompt` is optional since loaded sessions legitimately omit it. The full prompt is still written separately to the Continue Console log (`prompt.log`), and the GUI only ever read `usage` / `modelTitle`, so nothing functional is lost. This is an upstream behaviour (introduced in `438cba450`, predating this fork), not a regression from the token-counting features. Files: `core/util/history.ts`, `core/index.d.ts`, `gui/src/redux/thunks/streamNormalInput.ts`, `gui/src/components/FeedbackButtons.tsx`.

#### 1.4.0-preview.2

Based on upstream `continuedev/continue` (package version 1.3.40).

- **Added** — MCP Tool Args Display: toggle to show tool call arguments inline before approval
- **Added** — Tool Output Display: toggle to show the full response received from a tool after execution
- **Added** — Token Count: context usage percentage shown alongside the context bar
- **Fixed** — Chat horizontal overflow. The root layout used `w-screen` (`100vw`), which in Chromium includes the vertical scrollbar width, so the chat was wider than the visible webview and right-aligned controls were clipped. Replaced with `w-full`, added `min-w-0` on the chat column and `flex-shrink-0` on the history sidebar (`gui/src/pages/gui/index.tsx`).
- **Fixed** — Unintended horizontal scrolling of the message list. With `overflow-y: scroll` only, the horizontal axis computed to `auto`, letting messages shift independently from the input box. Added `overflow-x-hidden` on the steps container (`gui/src/pages/gui/Chat.tsx`).
- **Fixed** — Tool call action icons (args / output / truncate) cut off by long arguments. Tool titles interpolate raw arguments (`hasAlready: "edited {{{ filepath }}}"`, search queries, URLs), and `overflow-wrap: break-word` does **not** participate in `min-content` sizing, so an argument without spaces forced the row wider than its container. Switched to `overflow-wrap: anywhere` and made the icon group non-shrinking, so the text truncates instead of the buttons (`ToolCallStatusMessage.tsx`, `ToolCallDisplay.tsx`, `SimpleToolCallUI.tsx`).

> Note: Tailwind 3.4.17 has no `break-anywhere` utility (only `break-words`, `break-all`, `break-normal`, `break-keep`), hence the arbitrary `[overflow-wrap:anywhere]` class.

## What is Continue?

> _Note: The `continuedev/continue` repository is no longer actively maintained and is read-only for all users._

Continue is a coding agent available as a [CLI](#cli), [VS Code extension](#vs-code), and [JetBrains plugin](#jetbrains).

## Documentation

To learn how to configure Continue, how it works, and how to customize it, check out the [Continue Docs](https://docs.continue.dev).

## Final 2.0.0 Release

We polished Continue and did a final 2.0.0 release of the VS Code extension, CLI, and JetBrains plugin.

This included removing anonymous telemetry, pulling out authentication, squashing bugs, and more.

### VS Code

[![VS Code Marketplace](https://img.shields.io/badge/VS_Code_Marketplace-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=Continue.continue) [![OpenVSX Registry](https://img.shields.io/badge/OpenVSX_Registry-C160EF?logo=eclipseide&logoColor=white)](https://open-vsx.org/extension/Continue/continue) [![View source](https://img.shields.io/badge/View_source-181717?logo=github&logoColor=white)](extensions/vscode)

### CLI

[![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/@continuedev/cli) [![View source](https://img.shields.io/badge/View_source-181717?logo=github&logoColor=white)](extensions/cli)

### JetBrains

> _Note: We recommend using the Continue CLI instead of the JetBrains plugin._

[![GitHub Releases](https://img.shields.io/badge/GitHub_Releases-181717?logo=github&logoColor=white)](https://github.com/continuedev/continue/releases) [![View source](https://img.shields.io/badge/View_source-181717?logo=github&logoColor=white)](extensions/intellij)

## Contributors

Thank you to the entire Continue community for helping us create a pioneering coding agent.

What we built together pushed the boundaries of what AI developer tooling could be.

We hope this codebase continues to serve as a foundation for others.

## Code friends

<a href="https://github.com/continuedev/continue/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=continuedev/continue&max=500" />
</a>

## How to build

### GUI

```powershell
cd gui
npm run build
```

### VSCode extension

```powershell
cd extensions/vscode
npm install
npm run prepackage
npm run esbuild
npm run package
```

## How to install

```powershell
code --install-extension extensions/vscode/build/continue-1.4.0-preview.3.vsix
```

## Dev mode

```powershell
# Terminal 1 - watch GUI
cd gui
npm run dev
```

```powershell
# Terminal 2 - watch extension
cd extensions/vscode
npm run esbuild-watch
```

Then, go to `extensions/vscode` and press F5.

## Original Repository

[continuedev/continue](https://github.com/continuedev/continue)

## License

Apache 2.0 © 2023-2026 Continue Dev, Inc.
