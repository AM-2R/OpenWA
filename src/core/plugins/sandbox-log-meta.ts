/**
 * Counts the values JSON.stringify would write for a worker's log metadata, and stops once the count passes `limit`.
 *
 * JSON.stringify cannot be stopped part way: it lists every key of an object or typed array before it calls a
 * replacer for the first one, and it writes a shared reference out again at every use. So the size of the text has
 * to be bounded before it runs. A shared reference is counted at every use and a typed array by its length. The
 * count errs toward more: a property that JSON.stringify skips (undefined, a function, a symbol) and the entries of
 * a Map or Set (written as {}) are counted too. Every value that is written costs at least one character, so a
 * count past `limit` means a text longer than `limit`.
 */
export function countMetaValues(meta: unknown, limit: number): number {
  let count = 0;
  const open = new Set<object>();
  const frames: Array<{ node: object; items: ArrayLike<unknown>; next: number }> = [];
  const visit = (value: unknown): void => {
    count++;
    if (typeof value !== 'object' || value === null) return;
    if (ArrayBuffer.isView(value)) {
      count += (value as { length?: number }).length ?? 0;
      return;
    }
    if (value instanceof Map || value instanceof Set) {
      count += value.size;
      return;
    }
    // A cycle: JSON.stringify refuses it, so there is nothing more to count.
    if (open.has(value)) return;
    open.add(value);
    frames.push({ node: value, items: Array.isArray(value) ? value : Object.values(value), next: 0 });
  };
  visit(meta);
  while (frames.length > 0 && count <= limit) {
    const frame = frames[frames.length - 1];
    if (frame.next < frame.items.length) {
      visit(frame.items[frame.next++]);
    } else {
      open.delete(frame.node);
      frames.pop();
    }
  }
  return count;
}
