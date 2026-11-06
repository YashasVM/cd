import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CircleAlert,
  FolderOpen,
  Inbox,
  Link,
  Pause,
  Play,
  X,
} from "lucide-react";
import type { Transfer } from "./types";
import { bytes, percent } from "./format";

type Props = {
  transfers: Transfer[];
  onAction: (
    action: "pause" | "resume" | "reveal" | "revoke" | "invite",
    id: string,
  ) => void;
};
export function TransferList({ transfers, onAction }: Props) {
  if (!transfers.length)
    return (
      <div className="empty-handoffs">
        <Inbox size={27} />
        <h3>Your next handoff starts here.</h3>
        <p>Completed transfers will appear here.</p>
      </div>
    );
  return (
    <div className="transfer-list">
      {transfers.map((t) => {
        const done = t.status === "completed";
        const active = t.status === "transferring";
        const p = done ? 100 : percent(t.bytes, t.total);
        return (
          <article
            className={`transfer-row ${done ? "complete" : ""}`}
            key={t.id}
          >
            <div className="file-icon">
              {done ? (
                <Check />
              ) : t.direction === "send" ? (
                <ArrowUpRight />
              ) : (
                <ArrowDownLeft />
              )}
            </div>
            <div className="transfer-detail">
              <div className="transfer-title">
                <strong title={t.name}>{t.name}</strong>
                <span>{bytes(t.total)}</span>
              </div>
              <div className="transfer-meta">
                <span>
                  {t.status === "waiting"
                    ? "Waiting for receiver"
                    : `${t.direction === "send" ? "To" : "From"} ${t.peer}`}
                </span>
                <span className={`state ${t.status}`}>
                  {done
                    ? "Verified & complete"
                    : t.status === "waiting"
                      ? "Invite ready"
                      : t.status === "transferring"
                        ? `${p}% · ${bytes(t.bytes)} transferred`
                        : t.status === "paused"
                          ? "Paused · progress saved"
                          : t.status === "cancelled"
                            ? "Sharing stopped"
                            : "Needs attention"}
                </span>
              </div>
              {(active || t.status === "paused") && (
                <div
                  className="progress"
                  role="progressbar"
                  aria-label={`Transfer ${t.name}`}
                  aria-valuenow={p}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <i style={{ width: `${p}%` }} />
                </div>
              )}
              {t.error && (
                <p className="transfer-error">
                  <CircleAlert size={13} />
                  {t.error}
                </p>
              )}
            </div>
            <div className="row-actions">
              {t.direction === "receive" && active && (
                <button
                  className="icon-button"
                  title="Pause transfer"
                  aria-label={`Pause ${t.name}`}
                  onClick={() => onAction("pause", t.id)}
                >
                  <Pause size={17} />
                </button>
              )}
              {t.direction === "receive" &&
                (t.status === "paused" || t.status === "failed") && (
                  <button
                    className="icon-button"
                    title="Resume transfer"
                    aria-label={`Resume ${t.name}`}
                    onClick={() => onAction("resume", t.id)}
                  >
                    <Play size={17} />
                  </button>
                )}
              {t.direction === "send" &&
                (t.status === "waiting" || active || t.status === "paused") && (
                  <>
                    <button
                      className="icon-button"
                      title="Show invite"
                      aria-label={`Show invite for ${t.name}`}
                      onClick={() => onAction("invite", t.id)}
                    >
                      <Link size={17} />
                    </button>
                    <button
                      className="icon-button"
                      title="Stop sharing"
                      aria-label={`Stop sharing ${t.name}`}
                      onClick={() => onAction("revoke", t.id)}
                    >
                      <X size={17} />
                    </button>
                  </>
                )}
              {done && t.outputPath && (
                <button
                  className="icon-button"
                  title="Show in folder"
                  aria-label={`Show ${t.name} in folder`}
                  onClick={() => onAction("reveal", t.id)}
                >
                  <FolderOpen size={18} />
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
