import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpFromLine,
  ChevronRight,
  Clock3,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Settings2,
  Upload,
  Wifi,
  X,
} from "lucide-react";
import { desktop, native } from "./native";
import { errorMessage } from "./format";
import { Orbit } from "./Orbit";
import { TransferList } from "./TransferList";
import { ReceiveDialog, ShareDialog } from "./HandoffDialogs";
import { SettingsPage } from "./SettingsPage";
import type { Page, Share, Snapshot } from "./types";

export function App() {
  const [page, setPage] = useState<Page>("transfer");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const preparing = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [sharing, setSharing] = useState<Share | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [filter, setFilter] = useState<"all" | "send" | "receive">("all");
  const shares = useRef(new Map<string, Share>());
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await native.snapshot());
    } catch (e) {
      setToast(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 700);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 8000);
    return () => clearTimeout(id);
  }, [toast]);
  const sharePaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length || preparing.current) return;
      preparing.current = true;
      setBusy(true);
      try {
        const share = await native.share(paths);
        shares.current.set(share.id, share);
        setSharing(share);
        await refresh();
      } catch (e) {
        setToast(errorMessage(e));
      } finally {
        preparing.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!desktop) return;
    let dispose: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/webviewWindow")
      .then(async ({ getCurrentWebviewWindow }) => {
        const stop = await getCurrentWebviewWindow().onDragDropEvent(
          (event) => {
            setDragging(
              event.payload.type === "over" || event.payload.type === "enter",
            );
            if (event.payload.type === "drop") {
              setPage("transfer");
              void sharePaths(event.payload.paths);
            }
          },
        );
        if (disposed) stop();
        else dispose = stop;
      })
      .catch((e) => setToast(errorMessage(e)));
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [sharePaths]);
  async function choose(folder: boolean) {
    try {
      await sharePaths(await native.select(folder));
    } catch (e) {
      setToast(errorMessage(e));
    }
  }
  async function action(
    action: "pause" | "resume" | "reveal" | "revoke" | "invite",
    id: string,
  ) {
    try {
      if (action === "invite") {
        const share = shares.current.get(id);
        if (share) setSharing(share);
        else
          setToast("This invite is no longer available. Create a new handoff.");
      } else {
        await native[action](id);
        await refresh();
      }
    } catch (e) {
      setToast(errorMessage(e));
    }
  }
  const transfers = [...(snapshot?.transfers ?? [])].sort(
    (a, b) => b.startedAt - a.startedAt,
  );
  const activeCount = transfers.filter(
    (t) => t.status === "transferring",
  ).length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("transfer");
          }}
          aria-label="Nearby home"
        >
          <span className="monogram">cd</span>
          <span>
            <strong>Nearby</strong>
            <small>by CD</small>
          </span>
        </a>
        <nav aria-label="Main navigation">
          {(
            [
              { id: "transfer", label: "Transfer", icon: ArrowUpFromLine },
              { id: "activity", label: "Activity", icon: Clock3 },
              { id: "settings", label: "Settings", icon: Settings2 },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "selected" : ""}`}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={21} />
              {item.label}
              {item.id === "activity" && activeCount > 0 && (
                <span className="nav-count">{activeCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="this-device">
          <Laptop size={25} />
          <div>
            <strong>This device</strong>
            <span>{snapshot?.deviceName ?? "Starting Nearby…"}</span>
            <small>
              <i className={`dot ${desktop ? "" : "muted"}`} />
              {desktop ? "Ready to receive" : "Desktop preview"}
            </small>
          </div>
        </div>
      </aside>
      <main className="workspace">
        {page === "transfer" && (
          <>
            <header className="page-heading">
              <div>
                <h1>
                  A little closer<span>.</span>
                </h1>
                <p>Big files. Short distances. Straight to their device.</p>
              </div>
              <button
                className="button secondary pair-button"
                onClick={() => setReceiving(true)}
              >
                <Plus size={20} />
                Pair a device
              </button>
            </header>
            <div className="transfer-layout">
              <section className="send-panel">
                <h2>Send something good.</h2>
                <div
                  className={`dropzone ${dragging ? "dragging" : ""} ${busy ? "busy" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    if (!desktop)
                      setToast(
                        "Open the desktop app to drop local files and folders.",
                      );
                  }}
                >
                  <div className="upload-orb">
                    {busy ? (
                      <LoaderCircle size={40} className="spin" />
                    ) : (
                      <Upload size={40} strokeWidth={1.5} />
                    )}
                  </div>
                  <h3>
                    {busy
                      ? "Preparing your handoff…"
                      : dragging
                        ? "Let it go."
                        : "Drop files here"}
                  </h3>
                  <p>
                    {busy
                      ? "Verifying files and creating a private invitation."
                      : "Or choose a file or folder to get started"}
                  </p>
                  <div className="drop-actions">
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => choose(false)}
                    >
                      Choose files
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => choose(true)}
                    >
                      Choose folder
                    </button>
                  </div>
                </div>
                <div className="reassurance">
                  <LockKeyhole size={21} />
                  <span>Just your devices. No cloud in between.</span>
                </div>
              </section>
              <Orbit
                peers={snapshot?.peers ?? []}
                error={snapshot?.discoveryError ?? null}
                connect={() => setReceiving(true)}
              />
            </div>
            <section className="recent">
              <div className="section-heading">
                <h2>Recent handoffs</h2>
                <button
                  className="text-button"
                  onClick={() => setPage("activity")}
                >
                  View activity
                  <ChevronRight size={16} />
                </button>
              </div>
              <TransferList
                transfers={transfers.slice(0, 3)}
                onAction={action}
              />
            </section>
          </>
        )}
        {page === "activity" && (
          <>
            <header className="page-heading">
              <div>
                <h1>From here to there.</h1>
                <p>Your handoffs, with every byte accounted for.</p>
              </div>
              <button
                className="button primary"
                onClick={() => setPage("transfer")}
              >
                <Plus size={18} />
                New handoff
              </button>
            </header>
            <div className="activity-toolbar">
              <div className="filters" aria-label="Filter handoffs">
                {(["all", "send", "receive"] as const).map((f) => (
                  <button
                    key={f}
                    aria-pressed={filter === f}
                    className={filter === f ? "active" : ""}
                    onClick={() => setFilter(f)}
                  >
                    {f === "all"
                      ? "All handoffs"
                      : f === "send"
                        ? "Sending"
                        : "Receiving"}
                  </button>
                ))}
              </div>
              <span>
                {transfers.length}{" "}
                {transfers.length === 1 ? "handoff" : "handoffs"}
              </span>
            </div>
            <TransferList
              transfers={transfers.filter(
                (t) => filter === "all" || t.direction === filter,
              )}
              onAction={action}
            />
            <p className="activity-help">
              <LockKeyhole size={15} />
              Interrupted? Resume a handoff to continue from verified progress.
            </p>
          </>
        )}
        {page === "settings" && snapshot && (
          <SettingsPage settings={snapshot.settings} changed={refresh} />
        )}
        <footer className="statusbar">
          <span>
            <Wifi size={15} />
            {desktop
              ? "Local network"
              : "Interface preview · desktop app required"}
          </span>
          <span>
            <LockKeyhole size={14} />
            Encrypted device-to-device
          </span>
        </footer>
      </main>
      {sharing && (
        <ShareDialog share={sharing} close={() => setSharing(null)} />
      )}
      {receiving && (
        <ReceiveDialog
          defaultDir={snapshot?.settings.downloadDir ?? ""}
          close={() => setReceiving(false)}
          received={() => {
            setReceiving(false);
            setPage("activity");
            void refresh();
          }}
        />
      )}
      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={17} />
          </button>
        </div>
      )}
    </div>
  );
}
