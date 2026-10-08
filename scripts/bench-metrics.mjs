export function summarize(trials) {
  const complete = trials.filter((trial) => trial.completed);
  const median = (key) => {
    const values = complete.map((trial) => trial[key]).filter(Number.isFinite).sort((a, b) => a - b);
    const factor = key === 'seconds' ? 10000 : 100;
    return values.length ? Math.round(values[Math.floor(values.length / 2)] * factor) / factor : null;
  };
  return { runs: trials.length, completed: complete.length, completionRate: complete.length / trials.length,
    readinessMs: median('readinessMs'), parentExitMs: median('parentExitMs'),
    seconds: median('seconds'), mibPerSecond: median('mibPerSecond'),
    outputBytes: median('outputBytes'), trials };
}

