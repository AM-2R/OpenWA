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

  it('counts every value, containers included, and the name of every property', () => {
    expect(countMetaValues(null, NO_LIMIT)).toBe(1);
    expect(countMetaValues([1, [2, 3]], NO_LIMIT)).toBe(1 + 1 + 1 + 2);
    // The root, then a: name and value, b: name, array and two elements, c: name, object, d: name and value.
    expect(countMetaValues({ a: 1, b: [1, 2], c: { d: true } }, NO_LIMIT)).toBe(
      1 + (1 + 1) + (1 + 1 + 2) + (1 + 1 + 1 + 1),
    );
  });

  // Each character of a string is written, and a string shared by several references is written at every use.
  it('counts a string by its length, a shared one at every use', () => {
    expect(countMetaValues('text', NO_LIMIT)).toBe(1 + 4);
    expect(countMetaValues('', NO_LIMIT)).toBe(1);
    expect(countMetaValues({ d: 'x'.repeat(100) }, NO_LIMIT)).toBe(1 + 1 + 1 + 100);
    expect(countMetaValues(['abc', 'abc'], NO_LIMIT)).toBe(1 + 2 * (1 + 3));
    const small = { s: 'x'.repeat(10) };
    expect(countMetaValues({ list: [small, small] }, NO_LIMIT)).toBe(1 + 4 + 1 + 2 * (1 + 1 + 1 + 10));

    const holder = { s: 'x'.repeat(500_000) };
    const started = Date.now();
    const count = countMetaValues({ list: Array.from({ length: 2000 }, () => holder) }, 8192);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(count).toBeGreaterThan(8192);
  });

  it('counts a shared reference at every use', () => {
    const shared = { x: 1 };

    expect(countMetaValues({ a: shared, b: shared }, NO_LIMIT)).toBe(1 + 2 * (1 + 1 + 1 + 1));
  });

  it('counts a typed array by its length, and a Map or a Set by its size', () => {
    expect(countMetaValues(new Uint8Array(100), NO_LIMIT)).toBe(1 + 100);
    expect(countMetaValues(Buffer.alloc(7), NO_LIMIT)).toBe(1 + 7);
    expect(countMetaValues(new Map([[1, 2]]), NO_LIMIT)).toBe(1 + 1);
    expect(countMetaValues(new Set([1, 2, 3]), NO_LIMIT)).toBe(1 + 3);
  });

  // JSON.stringify writes a boxed primitive as the primitive it holds; its own properties are the characters of a
  // String wrapper, one per index, which are not values of their own.
  it('counts a String wrapper by its length without listing its characters', () => {
    const started = Date.now();
    const count = countMetaValues({ boxed: new String('x'.repeat(10_000_000)) }, 8192);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(count).toBe(1 + 5 + 1 + 10_000_000);
    expect(countMetaValues(new String('abc'), NO_LIMIT)).toBe(1 + 3);
    // What structuredClone hands back may come from another realm, where instanceof String is false.
    expect(countMetaValues(structuredClone(new String('abc')), NO_LIMIT)).toBe(1 + 3);
    expect(countMetaValues(structuredClone(new String('x'.repeat(10_000_000))), 8192)).toBe(1 + 10_000_000);
  });

  it('counts a Number, Boolean or BigInt wrapper as one value', () => {
    expect(countMetaValues(new Number(42), NO_LIMIT)).toBe(1);
    expect(countMetaValues(new Boolean(false), NO_LIMIT)).toBe(1);
    expect(countMetaValues(Object(10n), NO_LIMIT)).toBe(1);
  });

  // JSON.stringify writes the name of a property at every use of the object that has it, as it writes its value.
  it('counts a property name by its length, a shared object at every use', () => {
    expect(countMetaValues({ abc: 1 }, NO_LIMIT)).toBe(1 + 3 + 1);
    expect(countMetaValues({ '': 1 }, NO_LIMIT)).toBe(1 + 0 + 1);
    expect(countMetaValues({ a: { bcd: 1 } }, NO_LIMIT)).toBe(1 + 1 + 1 + 3 + 1);
    expect(countMetaValues([{ abc: 1 }, { abc: 1 }], NO_LIMIT)).toBe(1 + 2 * (1 + 3 + 1));

    const holder = { ['k'.repeat(100_000)]: 1 };
    const started = Date.now();
    const count = countMetaValues(
      Array.from({ length: 4000 }, () => holder),
      8192,
    );

    expect(Date.now() - started).toBeLessThan(1000);
    expect(count).toBeGreaterThan(8192);
  });

  it('counts a property that JSON.stringify skips, so the count can only err toward more', () => {
    expect(countMetaValues({ a: undefined, b: () => 1, c: Symbol('s') }, NO_LIMIT)).toBe(1 + 3 * (1 + 1));
  });

  it('does not follow a cycle', () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;

    // The root, id: name and value, self: name and the root met again (counted once, not followed).
    expect(countMetaValues(circular, 8192)).toBe(1 + (2 + 1) + (4 + 1));
  });

  it('stops once the count passes the limit, however large the text would be', () => {
    const started = Date.now();
    const count = countMetaValues(fanOut(9), 8192);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(count).toBeGreaterThan(8192);
    expect(count).toBeLessThanOrEqual(8192 + 3);
  });

  // The root costs 1 and every element 1: the walk stops at the first count past the limit, not before or after it.
  it('stops at the first count past the limit', () => {
    expect(countMetaValues(new Array<number>(20_000).fill(1), 8192)).toBe(8193);
    expect(countMetaValues(new Array<number>(8191).fill(1), 8192)).toBe(8192);
    expect(countMetaValues(new Array<number>(8192).fill(1), 8192)).toBe(8193);
  });

  it('counts a typed array without visiting its elements', () => {
    const started = Date.now();
    const count = countMetaValues({ b: new Uint8Array(20_000_000) }, 8192);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(count).toBe(1 + 1 + 1 + 20_000_000);
  });

  it('handles nesting far deeper than the call stack allows', () => {
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i++) deep = { next: deep };

    expect(countMetaValues(deep, 8192)).toBeGreaterThan(8192);
    expect(countMetaValues({ a: { b: { c: 1 } } }, 8192)).toBe(1 + 2 + 2 + 2);
  });
});
