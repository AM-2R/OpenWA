import { exceedsBodyNesting, MAX_BODY_NESTING } from './body-nesting';

// One value holding `levels` nested containers: {} is one level, {a:{}} is two.
const objects = (levels: number): unknown => {
  let value: unknown = {};
  for (let i = 1; i < levels; i++) value = { a: value };
  return value;
};
const arrays = (levels: number): unknown => {
  let value: unknown = [];
  for (let i = 1; i < levels; i++) value = [value];
  return value;
};

describe('exceedsBodyNesting', () => {
  it.each([
    ['objects', objects],
    ['arrays', arrays],
  ])('passes %s nested to the cap and refuses one level more', (_kind, build) => {
    expect(exceedsBodyNesting(build(MAX_BODY_NESTING))).toBe(false);
    expect(exceedsBodyNesting(build(MAX_BODY_NESTING + 1))).toBe(true);
  });

  it('measures the deepest branch, not the breadth or the number of nodes', () => {
    const wide = { items: Array.from({ length: 5000 }, () => ({ tags: ['a', 'b'], meta: { k: [1] } })) };
    expect(exceedsBodyNesting(wide)).toBe(false);
    const oneDeepBranch = { items: [...wide.items, { deep: objects(MAX_BODY_NESTING) }] };
    expect(exceedsBodyNesting(oneDeepBranch)).toBe(true);
  });

  // The recursive readers of a body overflow the stack near 2000 levels. The walk stops descending at the
  // cap, so it must answer for a value far deeper than that instead of overflowing like them.
  it.each([
    ['objects', objects],
    ['arrays', arrays],
  ])('answers for %s nested 100000 levels without overflowing the stack', (_kind, build) => {
    expect(exceedsBodyNesting(build(100_000))).toBe(true);
  });

  it.each([[undefined], [null], ['text'], [5], [true], [{}], [[]]])('passes the flat value %j', value => {
    expect(exceedsBodyNesting(value)).toBe(false);
  });
});
