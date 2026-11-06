import { useState } from "react";
import {
  ArrowDownToLine,
  Check,
  Copy,
  File,
  Folder,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import { Dialog } from "./Dialog";
import { bytes, errorMessage } from "./format";
import { native } from "./native";
import type { Offer, Share } from "./types";

export function ShareDialog({
  share,
  close,
}: {
  share: Share;
  close: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog title="A handoff, ready to go." close={close}>
      <p className="dialog-intro">
        Send this private invite to the other device. Keep Nearby open until the
        handoff is complete.
      </p>
      <div className="offer-summary">
        <div className="file-icon">
          <File />
        </div>
        <div>
          <strong>{share.name}</strong>
          <p>
            {share.files.length} {share.files.length === 1 ? "file" : "files"} ·{" "}
            {bytes(share.size)}
          </p>
        </div>
        <ShieldCheck className="success-icon" />
      </div>
      <label className="field-label" htmlFor="share-invite">
        Private invitation
      </label>
      <textarea
        id="share-invite"
        className="invite-value"
        readOnly
        value={share.invite}
        rows={3}
        onFocus={(e) => e.target.select()}
      />
      <p className="field-help">
        <LockKeyhole size={14} />
        Anyone with this invite can receive this handoff.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="button primary full"
        onClick={async () => {
          try {
            await native.copy(share.invite);
            setCopied(true);
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}{" "}
        {copied ? "Invite copied" : "Copy private invite"}
      </button>
      <div className="dialog-note">
        On the other device, choose <strong>Connect with an invite</strong>.
        Both devices must be on a reachable local network.
      </div>
    </Dialog>
  );
}

export function ReceiveDialog({
  defaultDir,
  close,
  received,
}: {
  defaultDir: string;
  close: () => void;
  received: () => void;
}) {
  const [invite, setInvite] = useState("");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [destination, setDestination] = useState(defaultDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setOffer(await native.inspect(invite.trim()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    setBusy(true);
    setError("");
    try {
      await native.receive(invite.trim(), destination);
      received();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={offer ? "Something good is incoming." : "Make the connection."}
      close={close}
      busy={busy}
    >
      {offer ? (
        <>
          <p className="dialog-intro">
            {offer.sender} is sharing a handoff with you. Review it before
            accepting.
          </p>
          <div className="offer-summary">
            <div className="file-icon">
              <File />
            </div>
            <div>
              <strong>{offer.name}</strong>
              <p>
                {offer.files.length} files · {bytes(offer.size)}
              </p>
            </div>
            <ShieldCheck className="success-icon" />
          </div>
          <div className="manifest-list">
            {offer.files.slice(0, 50).map((f) => (
              <div key={f.path}>
                <span title={f.path}>{f.path}</span>
                <small>{bytes(f.size)}</small>
              </div>
            ))}
            {offer.files.length > 50 && (
              <p>And {offer.files.length - 50} more files</p>
            )}
          </div>
          <label className="field-label">Save to</label>
          <button
            className="destination-picker"
            disabled={busy}
            onClick={async () => {
              try {
                const d = await native.destination();
                if (d) setDestination(d);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            <Folder size={18} />
            <span>{destination || "Choose a folder"}</span>
            <span className="text-accent">Change</span>
          </button>
          <p className="field-help">
            <ShieldCheck size={15} />
            Connection verified against the private invite.
          </p>
          <button
            className="button primary full"
            disabled={busy || !destination}
            onClick={accept}
          >
            <ArrowDownToLine size={18} />
            {busy ? "Starting handoff…" : "Accept & receive"}
          </button>
        </>
      ) : (
        <>
          <p className="dialog-intro">
            Paste an invite from another device on your network. You’ll see
            what’s inside before accepting.
          </p>
          <label className="field-label" htmlFor="incoming-invite">
            Private invitation
          </label>
          <textarea
            autoFocus
            id="incoming-invite"
            placeholder="nearby:…"
            rows={4}
            value={invite}
            spellCheck={false}
            onChange={(e) => setInvite(e.target.value)}
          />
          <p className="field-help">
            <LockKeyhole size={14} />A direct, encrypted connection. No account
            needed.
          </p>
          <button
            className="button primary full"
            disabled={busy || !invite.trim()}
            onClick={inspect}
          >
            {busy ? "Checking the invitation…" : "Preview handoff"}
          </button>
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
