"""Regenerate summary.json from the completed audit artifacts."""
import json
import statistics
from pathlib import Path

root = Path(__file__).resolve().parent


def read(name):
    return json.loads((root / name).read_text())


def summarize(trials):
    good = [trial for trial in trials if trial["completed"]]
    return {
        "completed": len(good),
        "runs": len(trials),
        "medianMiBPerSecond": statistics.median(t["mibPerSecond"] for t in good),
        "minMiBPerSecond": min(t["mibPerSecond"] for t in good),
        "maxMiBPerSecond": max(t["mibPerSecond"] for t in good),
    }


network = read("network.json")
browser = read("browser-storage.json")
cli = read("cli-head-comparison-warm.json")
routes = read("browser-interleaved-light.json")
full_routes = read("browser-interleaved.json")
summary = {
    "units": "MiB/s, where MiB = 1048576 bytes",
    "network": [
        {"mode": mode, "addedAckRTTMs": delay, **summarize([
            t for t in network["trials"]
            if t["mode"] == mode and t["addedAckRTTMs"] == delay
        ])}
        for delay in [0, 100, 300] for mode in ["v1", "v2"]
    ],
    "browserComponents": [
        {"mode": mode, "cpuThrottle": throttle, **summarize([
            t for t in browser["trials"] if t["suite"] == "browser"
            and t["mode"] == mode and t["throttle"] == throttle
        ])}
        for throttle in [1, 4]
        for mode in ["incremental-sha256", "native-sha256", "record-seal-open",
                     "opfs-stream", "resume-stage", "opfs-reopen", "opfs-sync-worker"]
    ],
    "cliHeadComparison": {
        mode: summarize([t for t in cli["trials"] if t["version"] == mode and not t["warmup"]])
        for mode in ["head", "current"]
    },
    "browserRoutesLight": {
        mode: summarize([t for t in routes["trials"] if t["mode"] == mode and not t["warmup"]])
        for mode in ["automatic", "relay"]
    },
    "browserRoutesFull": {
        mode: summarize([t for t in full_routes["trials"] if t["mode"] == mode and not t["warmup"]])
        for mode in ["automatic", "relay"]
    },
    "limitations": [
        "Local shared-host tests, not production internet capacity.",
        "Storage cases are component experiments, not end-to-end speedups.",
        "Detailed route probe had one setup failure; retained in denominator.",
        "An earlier light-probe export failed on BigInt; its log is retained and excluded.",
        "Original cold CLI comparison had two slow current trials; warmed repeat does not identify their cause.",
    ],
}
for key in ["network", "browserComponents"]:
    assert all(row["completed"] == row["runs"] for row in summary[key])
for key in ["cliHeadComparison", "browserRoutesLight"]:
    assert all(row["completed"] == row["runs"] for row in summary[key].values())
(root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
