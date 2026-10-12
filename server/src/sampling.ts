// Which days the collector still has to ask the beacon node for.
//
// A day's balance is read from the beacon state at that day's last slot. For
// any day older than the node's finalized-but-not-archived window that state
// only exists on an archive node, so re-reading the whole scan window on every
// run ties the tracker to archive storage for data it already has. Once a day
// is stored for every validator that was active on it, it never changes —
// except the most recent days: today is sampled at the head and moves until
// the day ends, and yesterday may have been sampled before it was over.

/** Days at the end of the window that are always re-sampled. */
export const RESAMPLE_RECENT_DAYS = 2

/**
 * @param days        the scan window, oldest first (ISO dates)
 * @param stored      per date, how many validators already have a balance row
 * @param activeCount per date, how many validators were active on it
 */
export function daysToSample(
  days: string[],
  stored: Map<string, number>,
  activeCount: (date: string) => number,
): string[] {
  const recent = new Set(days.slice(-RESAMPLE_RECENT_DAYS))
  return days.filter((d) => recent.has(d) || (stored.get(d) ?? 0) < activeCount(d))
}
