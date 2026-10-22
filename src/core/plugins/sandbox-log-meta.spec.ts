import { countMetaValues } from './sandbox-log-meta';

describe('countMetaValues', () => {
  const NO_LIMIT = Number.MAX_SAFE_INTEGER;
  const fanOut = (levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < levels; level++) {
      node = Object.fromEntries(Array.from({ length: 10 }, (_, key) => [`k${key}`, node]));
    }
    return node;
  };

  it('counts every value, containers included', () => {
    expect(countMetaValues('text', NO_LIMIT)).toBe(1);
    expect(countMetaValues(null, NO_LIMIT)).toBe(1);
    expect(countMetaValues({ a: 1, b: [1, 2], c: { d: 'x' } }, NO_LIMIT)).toBe(1 + 1 + 1 + 2 + 1 + 1);
  });

  it('counts a shared reference at every use', () => {
    const shared = { x: 1 };

    expect(countMetaValues({ a: shared, b: shared }, NO_LIMIT)).toBe(1 + 2 * (1 + 1));
  });

  it('counts a typed array by its length, and a Map or a Set by its size', () => {
    expect(countMetaValues(new Uint8Array(100), NO_LIMIT)).toBe(1 + 100);
    expect(countMetaValues(Buffer.alloc(7), NO_LIMIT)).toBe(1 + 7);
    expect(countMetaValues(new Map([[1, 2]]), NO_LIMIT)).toBe(1 + 1);
    expect(countMetaValues(new Set([1, 2, 3]), NO_LIMIT)).toBe(1 + 3);
  });

  it('counts a property that JSON.stringify skips, so the count can only err toward more', () => {
    expect(countMetaValues({ a: undefined, b: () => 1, c: Symbol('s') }, NO_LIMIT)).toBe(1 + 3);
  });

  it('does not follow a cycle', () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;

    expect(countMetaValues(circular, 8192)).toBe(1 + 1 + 1);
  });

  it('stops once the count passes the limit, however large the text would be', () => {
    const started = Date.now();
    const count = countMetaValues(fanOut(9), 8192);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(count).toBe(8193);
  });

  it('counts a typed array without visiting its elements', () => {
    const started = Date.now();
    const count = countMetaValues({ b: new Uint8Array(20_000_000) }, 8192);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(count).toBe(1 + 1 + 20_000_000);
  });

  it('handles nesting far deeper than the call stack allows', () => {
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i++) deep = { next: deep };

    expect(countMetaValues(deep, 8192)).toBeGreaterThan(8192);
    expect(countMetaValues({ a: { b: { c: 1 } } }, 8192)).toBe(1 + 1 + 1 + 1);
  });
});
