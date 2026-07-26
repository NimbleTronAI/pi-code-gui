export function mergeInitialHistoryEvents<T>(
  cachedInitialEvents: readonly T[],
  pendingEvents: readonly T[],
): T[] {
  if (cachedInitialEvents.length === 0) { return pendingEvents.slice(); }

  const cachedEvents = new Set(cachedInitialEvents);
  return [
    ...cachedInitialEvents,
    ...pendingEvents.filter((event) => !cachedEvents.has(event)),
  ];
}
