import { History } from "../../components/History";
import { Chat } from "./Chat";

export default function GUI() {
  return (
    // w-full (not w-screen): 100vw includes the vertical scrollbar width in
    // Chromium, which makes the chat wider than the visible webview area and
    // clips right-aligned controls (tool call action buttons).
    <div className="flex min-h-0 w-full flex-row overflow-x-hidden">
      <aside className="4xl:flex border-vsc-input-border no-scrollbar hidden min-h-0 w-96 flex-shrink-0 overflow-y-auto border-0 border-r border-solid">
        <History />
      </aside>
      {/* min-w-0 lets the chat column shrink below its content's min-content
          width; without it a long tool call argument forces horizontal overflow. */}
      <main className="no-scrollbar flex min-h-0 min-w-0 flex-1 flex-col">
        <Chat />
      </main>
    </div>
  );
}
