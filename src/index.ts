import { ExtensionContext } from "@foxglove/extension";

import { initJanusStreamPanel } from "./JanusPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "Janus WebRTC Stream", initPanel: initJanusStreamPanel });
}
