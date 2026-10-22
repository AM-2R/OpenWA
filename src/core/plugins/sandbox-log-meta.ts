/**
 * Counts what JSON.stringify would write for a worker's log metadata, and stops once the count passes `limit`: one
 * for every value, one per character of a string, a String wrapper or a typed array element, and one per character
 * of a property name.
 *
 * JSON.stringify cannot be stopped part way: it lists every key of an object or typed array before it calls a
 * replacer for the first one, and it writes a shared reference out again at every use. So the size of the text has
 * to be bounded before it runs. A shared reference is counted at every use, and so is a property name, which is
 * written at every use of its object.
 *
 * The count can be higher than the length of the text. A property that JSON.stringify skips (undefined, a function,
 * a symbol) and the entries of a Map or Set (written as {}) are counted as if they were written. A metadata whose
 * count passes `limit` is replaced by the size marker whatever its text would measure; for data that is plain JSON
 * the count never exceeds the length of the text, so a count past `limit` means a longer text.
 */
export function countMetaValues(meta: unknown, limit: number): number {
  let count = 0;
  const open = new Set<object>();
  // An object is walked by its own enumerable keys, an array by its elements.
  const frames: Array<{ node: object; keys: string[] | null; length: number; next: number }> = [];
  const visit = (value: unknown): void => {
    count++;
    if (typeof value === 'string') count += value.length;
    if (typeof value !== 'object' || value === null) return;
    if (ArrayBuffer.isView(value)) {
      count += (value as { length?: number }).length ?? 0;
      return;
    }
    if (value instanceof Map || value instanceof Set) {
      count += value.size;
      return;
    }
    // A String wrapper is written as its text, and its own properties are its characters, one per index. Its brand
    // is checked rather than instanceof, so a wrapper made in another realm counts too.
    if (Object.prototype.toString.call(value) === '[object String]') {
      count += (value as { length: number }).length;
      return;
    }
    // A cycle: JSON.stringify refuses it, so there is nothing more to count.
    if (open.has(value)) return;
    open.add(value);
    const keys = Array.isArray(value) ? null : Object.keys(value);
    frames.push({ node: value, keys, length: keys ? keys.length : (value as unknown[]).length, next: 0 });
  };
  visit(meta);
  while (frames.length > 0 && count <= limit) {
    const frame = frames[frames.length - 1];
    if (frame.next < frame.length) {
      const index = frame.next++;
      if (frame.keys) {
        count += frame.keys[index].length;
        visit((frame.node as Record<string, unknown>)[frame.keys[index]]);
      } else {
        visit((frame.node as unknown[])[index]);
      }
    } else {
      open.delete(frame.node);
      frames.pop();
    }
  }
  return count;
}
