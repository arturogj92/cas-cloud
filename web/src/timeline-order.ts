export function orderTimelineItems<T extends { startedAtMs?: number | null }>(items: T[]) {
  let lastTimestamp = Number.NEGATIVE_INFINITY;
  return items
    .map((item, index) => {
      if (Number.isFinite(item.startedAtMs)) lastTimestamp = item.startedAtMs!;
      return { item, index, timestamp: lastTimestamp };
    })
    .sort((a, b) => a.timestamp === b.timestamp ? a.index - b.index : a.timestamp - b.timestamp)
    .map(({ item }) => item);
}

/**
 * Index where the visible tail of the timeline starts so that at most
 * `messageLimit` conversation messages are kept. Work items (tool calls, which
 * fold into one "Worked for" row) and todo items never count: counting raw items
 * let one tool-heavy turn evict the messages around it, so the reader landed on
 * a lone "Worked for" and had to scroll up.
 */
export function retainedTimelineStart<T>(items: T[], messageLimit: number, isMessage: (item: T) => boolean) {
  let messages = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!isMessage(items[index])) continue;
    messages += 1;
    if (messages > messageLimit) return index + 1;
  }
  return 0;
}
