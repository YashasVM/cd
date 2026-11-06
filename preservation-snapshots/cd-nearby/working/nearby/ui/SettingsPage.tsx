import { useState } from "react";
import { Check, Folder, LockKeyhole } from "lucide-react";
import { native, desktop } from "./native";
import { errorMessage } from "./format";
import type { Settings } from "./types";

export function SettingsPage({
  settings,
  changed,
}: {
  settings: Settings;
  changed: () => void;
}) {
  const [value, setValue] = useState(settings);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="settings-page">
      <header className="page-heading">
        <h1>Make yourself at home.</h1>
        <p>A few things to make every handoff feel familiar.</p>
      </header>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await native.settings(value);
            setSaved(true);
            changed();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <section className="setting-section">
          <h2>Your device</h2>
          <p>This name appears to people on your local network.</p>
          <label className="field-label" htmlFor="device-name">
            Device name
          </label>
          <input
            id="device-name"
            value={value.deviceName}
            maxLength={48}
            required
            onChange={(e) => {
              setValue({ ...value, deviceName: e.target.value });
              setSaved(false);
            }}
          />
        </section>
        <section className="setting-section">
          <h2>A place for incoming files</h2>
          <p>You can choose a different folder before each handoff.</p>
          <label className="field-label">Default receive folder</label>
          <button
            type="button"
            className="destination-picker"
            onClick={async () => {
              try {
                const path = await native.destination();
                if (path) {
                  setValue({ ...value, downloadDir: path });
                  setSaved(false);
                }
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            <Folder size={18} />
            <span>{value.downloadDir || "Choose a folder"}</span>
            <span className="text-accent">Browse</span>
          </button>
        </section>
        <button
          className="button primary"
          disabled={busy || !value.deviceName.trim() || !desktop}
        >
          {saved ? <Check size={17} /> : null}
          {busy ? "Saving…" : saved ? "Preferences saved" : "Save preferences"}
        </button>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="privacy-note">
        <LockKeyhole size={24} />
        <div>
          <h3>Small footprint. Yours to keep.</h3>
          <p>
            Files travel directly between devices. Partial downloads stay on the
            receiving device so interrupted handoffs can resume. No account, no
            cloud storage, no analytics.
          </p>
          <p>
            Closing the desktop window keeps handoffs running. Use the tray menu
            to quit Nearby.
          </p>
        </div>
      </div>
      <p className="version">CD Nearby · 0.1.0 · Built with Rust</p>
    </div>
  );
}
