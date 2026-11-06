import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Offer, Settings, Share, Snapshot } from "./types";

export const desktop = isTauri();
const preview: Snapshot = {
  deviceName: "My computer",
  transfers: [],
  peers: [],
  discoveryError: "Open the desktop app to discover devices.",
  settings: { deviceName: "My computer", downloadDir: "" },
};
function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop)
    return Promise.reject(
      new Error(
        "This is the interface preview. Open CD Nearby on your desktop to transfer files.",
      ),
    );
  return invoke<T>(name, args);
}
export const native = {
  snapshot: () =>
    desktop ? command<Snapshot>("snapshot") : Promise.resolve(preview),
  select: (folder: boolean) => command<string[]>("select_paths", { folder }),
  destination: () => command<string | null>("select_destination"),
  share: (paths: string[]) => command<Share>("share", { paths }),
  inspect: (invite: string) => command<Offer>("inspect_invite", { invite }),
  receive: (invite: string, destination: string) =>
    command<string>("receive", { invite, destination }),
  pause: (id: string) => command<void>("pause", { id }),
  resume: (id: string) => command<void>("resume", { id }),
  revoke: (id: string) => command<void>("revoke", { id }),
  reveal: (id: string) => command<void>("reveal", { id }),
  copy: (text: string) =>
    desktop
      ? command<void>("copy_text", { text })
      : navigator.clipboard.writeText(text),
  settings: (settings: Settings) =>
    command<void>("save_settings", { settings }),
};
