import { ListingMemo, LISTING_MEMO_TTL_MS } from './listing-memo';

describe('ListingMemo', () => {
  const list = (...ids: string[]) => jest.fn().mockImplementation(() => Promise.resolve(ids.map(id => ({ id }))));

  afterEach(() => jest.restoreAllMocks());

  it('reads afresh for a first page and reuses the list for the later pages', async () => {
    const memo = new ListingMemo<{ id: string }>();
    const load = list('a', 'b');
    await memo.read('s1', 0, load);
    await memo.read('s1', undefined, load);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(memo.read('s1', 1000, load)).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
    await memo.read('s1', 2000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([Number.NaN, -1])('treats offset %s as a first page', async offset => {
    const memo = new ListingMemo<{ id: string }>();
    const load = list('a');
    await memo.read('s1', 0, load);
    await memo.read('s1', offset, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps one list per session', async () => {
    const memo = new ListingMemo<{ id: string }>();
    await memo.read('s1', 0, list('a'));
    const other = list('b');
    await expect(memo.read('s2', 1000, other)).resolves.toEqual([{ id: 'b' }]);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('reads afresh once the list is older than its time to live', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const memo = new ListingMemo<{ id: string }>();
    const load = list('a');
    await memo.read('s1', 0, load);
    clock.mockReturnValue(now + LISTING_MEMO_TTL_MS - 1);
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + LISTING_MEMO_TTL_MS);
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares a read in flight with a later page', async () => {
    const memo = new ListingMemo<{ id: string }>();
    let finish: (items: { id: string }[]) => void = () => undefined;
    const load = jest.fn(() => new Promise<{ id: string }[]>(resolve => (finish = resolve)));
    const first = memo.read('s1', 0, load);
    const later = memo.read('s1', 1000, load);
    finish([{ id: 'a' }]);
    await expect(Promise.all([first, later])).resolves.toEqual([[{ id: 'a' }], [{ id: 'a' }]]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed read, and an older failure leaves a newer list in place', async () => {
    const memo = new ListingMemo<{ id: string }>();
    await expect(memo.read('s1', 0, () => Promise.reject(new Error('page died')))).rejects.toThrow('page died');
    const load = list('a');
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);

    let fail: (error: Error) => void = () => undefined;
    const slow = memo.read('s1', 0, () => new Promise((_, reject) => (fail = reject)));
    await memo.read('s1', 0, load);
    fail(new Error('page died'));
    await expect(slow).rejects.toThrow('page died');
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reads afresh after a drop, including a drop while the read was in flight', async () => {
    const memo = new ListingMemo<{ id: string }>();
    const load = list('a');
    await memo.read('s1', 0, load);
    memo.drop('s1');
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);

    const pending = memo.read('s1', 0, load);
    memo.drop('s1');
    await pending;
    await memo.read('s1', 1000, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('hands every caller its own copy of the list', async () => {
    const memo = new ListingMemo<{ id: string }>();
    const first = await memo.read('s1', 0, list('a', 'b'));
    first.reverse().pop();
    await expect(memo.read('s1', 1000, list())).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});
