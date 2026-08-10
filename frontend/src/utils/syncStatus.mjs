export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unavailable";
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function getEstimatedTimeRemaining(blocksBehind, blocksPerSecond) {
  if (
    !Number.isFinite(blocksBehind) ||
    !Number.isFinite(blocksPerSecond) ||
    blocksBehind < 0 ||
    blocksPerSecond <= 0
  ) {
    return "Warming up";
  }
  return formatDuration(blocksBehind / blocksPerSecond);
}

export function getPipelineSummary(status) {
  const pipeline = status?.metrics?.pipeline;
  if (!pipeline || pipeline.samples === 0) return null;

  return {
    throughput: status.metrics.blocksPerSecond || 0,
    averageBlockSeconds: (pipeline.averageMs?.total || 0) / 1000,
    mainPrefetchSeconds: (pipeline.averageMs?.mainPrefetch || 0) / 1000,
    commitSeconds: (pipeline.averageMs?.commit || 0) / 1000,
    samples: pipeline.samples,
  };
}
