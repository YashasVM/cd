import { Laptop, Link, WifiOff } from "lucide-react";
import type { Peer } from "./types";
import { desktop } from "./native";

export function Orbit({
  peers,
  error,
  connect,
}: {
  peers: Peer[];
  error: string | null;
  connect: () => void;
}) {
  const listening = desktop && !error;
  return (
    <aside className="orbit-panel">
      <div className="section-heading">
        <h2>In your orbit</h2>
        <span className="listening">
          <i className={listening ? "dot" : "dot muted"} />
          {listening
            ? "Listening"
            : desktop
              ? "Unavailable"
              : "Desktop preview"}
        </span>
      </div>
      <div
        className={`orbit ${listening ? "is-listening" : ""}`}
        aria-hidden="true"
      >
        <div className="orbit-ring outer" />
        <div className="orbit-ring middle" />
        <div className="orbit-ring inner" />
        <div className="orbit-center">
          <Laptop size={31} />
        </div>
        <div className="satellite one">
          <Laptop size={21} />
        </div>
        <div className="satellite two">
          <Laptop size={21} />
        </div>
      </div>
      {peers.length ? (
        <div className="peer-list">
          {peers.map((p) => (
            <button key={p.id} className="peer" onClick={connect}>
              <span className="peer-icon">
                <Laptop size={21} />
              </span>
              <span>
                <strong>{p.name}</strong>
                <small>Nearby · connect with an invite</small>
              </span>
              <Link size={16} />
            </button>
          ))}
        </div>
      ) : (
        <div className="orbit-copy">
          <h3>
            {error && desktop
              ? "Discovery is unavailable"
              : "Looking for nearby devices"}
          </h3>
          <p>
            {error && desktop
              ? error
              : "Open Nearby on another device on this network."}
          </p>
        </div>
      )}
      <button className="button secondary connect-button" onClick={connect}>
        {error && desktop ? <WifiOff size={17} /> : <Link size={17} />}Connect
        with an invite
      </button>
    </aside>
  );
}
