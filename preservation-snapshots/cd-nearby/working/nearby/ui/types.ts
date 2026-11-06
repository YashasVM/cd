export type FileInfo = { path: string; size: number; sha256: string };
export type Share = {
  id: string;
  invite: string;
  name: string;
  size: number;
  files: FileInfo[];
};
export type Offer = {
  name: string;
  sender: string;
  size: number;
  files: FileInfo[];
};
export type Transfer = {
  id: string;
  name: string;
  peer: string;
  direction: "send" | "receive";
  status:
    | "waiting"
    | "transferring"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";
  bytes: number;
  total: number;
  files: FileInfo[];
  error: string | null;
  outputPath: string | null;
  startedAt: number;
};
export type Peer = {
  id: string;
  name: string;
  address: string;
  lastSeen: number;
};
export type Settings = { deviceName: string; downloadDir: string };
export type Snapshot = {
  deviceName: string;
  transfers: Transfer[];
  peers: Peer[];
  discoveryError: string | null;
  settings: Settings;
};
export type Page = "transfer" | "activity" | "settings";
