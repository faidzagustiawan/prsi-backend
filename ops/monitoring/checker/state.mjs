export const ENTITIES = ['companies', 'projects', 'clusters', 'units', 'customers', 'assignments', 'payments'];
export function advance(previous, track, prsi, now) {
  for (const result of [track, prsi]) {
    if (!Number.isSafeInteger(result?.count) || result.count < 0 || !/^[a-f0-9]{32}$/.test(result.content_hash ?? '')) throw new Error('Invalid checksum');
  }
  if (!/^\d+$/.test(track.watermark ?? '') || typeof prsi.held !== 'boolean') throw new Error('Invalid checksum metadata');
  const same = track.count === prsi.count && track.content_hash === prsi.content_hash;
  const source = `${track.count}:${track.content_hash}`;
  // xmin is NOT the last event cursor. Repeated differences are observations,
  // never proof of corruption or that the mirror has caught up.
  const stable = previous?.source === source;
  const streak = !same && !prsi.held ? (stable ? previous?.streak ?? 0 : 0) + 1 : 0;
  return { source, streak, match: same ? 1 : (streak >= 3 ? 0 : -1), pending: !same && streak < 3,
    lastMatch: same ? now : previous?.lastMatch ?? 0, trackCount: track.count, prsiCount: prsi.count,
    differenceSince: same ? 0 : previous?.differenceSince || now,
    mismatches: (previous?.mismatches ?? 0) + Number(streak === 3) };
}
