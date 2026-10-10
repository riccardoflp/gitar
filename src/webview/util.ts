const LANE_COLORS = ['#4c9df3', '#b57edc', '#3fb68b', '#e5a13a', '#e06c75', '#56b6c2', '#c678dd', '#98c379'];

export const laneColor = (index: number) => LANE_COLORS[index % LANE_COLORS.length];

export const shortHash = (hash: string) => hash.slice(0, 7);

export function relativeTime(seconds: number, now = Date.now()): string {
  const elapsed = Math.max(0, now / 1000 - seconds);
  if (elapsed < 60) return 'now';
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  if (elapsed < 86400 * 7) return `${Math.floor(elapsed / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const fullDate = (seconds: number) => new Date(seconds * 1000).toLocaleString();
