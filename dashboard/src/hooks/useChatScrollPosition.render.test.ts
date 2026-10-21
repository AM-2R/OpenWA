// The scroll-position hook mounted on a real container. jsdom has no layout and fires no scroll event
// when a shrinking thread clamps scrollTop, so the container below models both: scrollTop is clamped
// to the content height, and the test dispatches the scroll event a browser would.
import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useEffect, type MutableRefObject } from 'react';

let rtl: typeof import('@testing-library/react');
let useChatScrollPosition: (typeof import('./useChatScrollPosition.ts'))['useChatScrollPosition'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ useChatScrollPosition } = await import('./useChatScrollPosition.ts'));
});

after(() => rtl.cleanup());

const CLIENT_HEIGHT = 400;
// A loaded thread is 100 rows; a chat still loading shows one spinner row.
const LOADED_HEIGHT = 4600;
const SPINNER_HEIGHT = 400;

function Thread({ chatId, isLoaded }: { chatId: string; isLoaded: boolean }) {
  const { containerRef } = useChatScrollPosition(chatId, isLoaded, false);
  return createElement('div', { ref: containerRef, 'data-testid': 'thread' });
}

test('switching to a chat that is still loading does not save the clamped top as its position', async () => {
  const { render, screen, fireEvent } = rtl;
  let height = LOADED_HEIGHT;
  let top = 0;
  const maxTop = () => Math.max(0, height - CLIENT_HEIGHT);
  // Defined before the first commit, so the restore effects already see this geometry.
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => Math.min(top, maxTop()),
      set: (v: number) => {
        top = Math.max(0, Math.min(v, maxTop()));
      },
    },
  });
  try {
    const { rerender } = render(createElement(Thread, { chatId: 'A', isLoaded: true }));
    const el = screen.getByTestId('thread');
    assert.equal(el.scrollTop, maxTop(), 'chat A did not open at the bottom');
    fireEvent.scroll(el); // the event a browser fires for that write
    el.scrollTop = 3000; // the operator reads a little way up
    fireEvent.scroll(el);

    // Chat B is not cached: the same container swaps A's thread for the spinner, and the browser
    // clamps scrollTop to 0 and reports it as a scroll on the next frame.
    height = SPINNER_HEIGHT;
    rerender(createElement(Thread, { chatId: 'B', isLoaded: false }));
    fireEvent.scroll(el);

    height = LOADED_HEIGHT;
    rerender(createElement(Thread, { chatId: 'B', isLoaded: true }));
    assert.equal(el.scrollTop, maxTop(), 'chat B opened at its oldest message instead of the newest');
  } finally {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  }
});

// An older page lands above the reader. Previews that swap in BELOW the reader while it is in flight grow
// the thread but move nothing on screen, so holding the reader by the thread's height delta dragged them
// down the thread by those pixels. The reader is held by the message they were on.
test('an older page holds the reader by their message, not by every pixel the thread grew', async () => {
  const { render, screen, cleanup } = rtl;
  cleanup();
  const top = { value: 0 };
  // Content-coordinate tops of the three messages the thread holds; the viewport shows 400px of them.
  const messageTops = new Map<string, number>([
    ['m1', 100],
    ['m2', 500],
    ['m3', 900],
  ]);
  let height = 1300;
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  const rectSaved = window.Element.prototype.getBoundingClientRect;
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => top.value,
      set: (v: number) => {
        top.value = Math.max(0, Math.min(v, height - CLIENT_HEIGHT));
      },
    },
  });
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const content = messageTops.get(this.getAttribute('data-id') ?? '');
    const y = content === undefined ? 0 : content - top.value;
    return { top: y, bottom: y + 300, left: 0, right: 0, width: 0, height: 300, x: 0, y } as DOMRect;
  };

  const request: MutableRefObject<(() => void) | null> = { current: null };
  function Older({ fetching }: { fetching: boolean }) {
    const { containerRef, onOlderMessagesRequested } = useChatScrollPosition('A', true, fetching);
    useEffect(() => {
      request.current = onOlderMessagesRequested;
    });
    return createElement(
      'div',
      { ref: containerRef, 'data-testid': 'thread' },
      ['m1', 'm2', 'm3'].map(id => createElement('div', { key: id, 'data-id': id, 'data-scroll-anchor': '' })),
    );
  }

  try {
    const { rerender } = render(createElement(Older, { fetching: false }));
    const el = screen.getByTestId('thread');
    // The reader is on m2 (500..800 in content, the viewport 400..800), 100px below the container's top.
    top.value = 400;
    request.current?.();
    rerender(createElement(Older, { fetching: true }));

    // A 230px preview swaps in below m3 while the page is out, on a commit of its own before the page lands.
    // Nothing is applied for it, and it must not use up what is owed to the page.
    height += 230;
    rerender(createElement(Older, { fetching: true }));
    assert.equal(el.scrollTop, 400, 'a commit while the page was out moved the reader');

    // The page lands: 2000px of history above.
    for (const [id, y] of [...messageTops]) messageTops.set(id, y + 2000);
    height += 2000;
    rerender(createElement(Older, { fetching: false }));

    assert.equal(el.scrollTop, 400 + 2000, 'the reader moved by more or less than the history above them');
  } finally {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
    window.Element.prototype.getBoundingClientRect = rectSaved;
  }
});

// The reader's own scrolling while a page is in flight is not the content moving: it must survive the
// landing, and a reader who jumped to the bottom must still be at the bottom, now of the taller thread.
for (const scenario of [
  { name: 'scrolls down 300px', scrollTo: 700, expected: 700 + 2000 },
  { name: 'is carried to the top by momentum', scrollTo: 0, expected: 0 + 2000 },
  { name: 'jumps to the bottom', scrollTo: 900, expected: 900 + 2000 },
]) {
  test(`an older page keeps a position the reader moved to while it was in flight: ${scenario.name}`, async () => {
    const { render, screen, cleanup } = rtl;
    cleanup();
    const top = { value: 0 };
    const messageTops = new Map<string, number>([
      ['m1', 100],
      ['m2', 500],
      ['m3', 900],
    ]);
    let height = 1300;
    const proto = window.HTMLDivElement.prototype;
    const saved = Object.getOwnPropertyDescriptors(proto);
    const rectSaved = window.Element.prototype.getBoundingClientRect;
    Object.defineProperties(proto, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
      scrollTop: {
        configurable: true,
        get: () => top.value,
        set: (v: number) => {
          top.value = Math.max(0, Math.min(v, height - CLIENT_HEIGHT));
        },
      },
    });
    window.Element.prototype.getBoundingClientRect = function (this: Element) {
      const content = messageTops.get(this.getAttribute('data-id') ?? '');
      const y = content === undefined ? 0 : content - top.value;
      return { top: y, bottom: y + 300, left: 0, right: 0, width: 0, height: 300, x: 0, y } as DOMRect;
    };
    const request: MutableRefObject<(() => void) | null> = { current: null };
    function Older({ fetching }: { fetching: boolean }) {
      const { containerRef, onOlderMessagesRequested } = useChatScrollPosition('A', true, fetching);
      useEffect(() => {
        request.current = onOlderMessagesRequested;
      });
      return createElement(
        'div',
        { ref: containerRef, 'data-testid': 'thread' },
        ['m1', 'm2', 'm3'].map(id => createElement('div', { key: id, 'data-id': id, 'data-scroll-anchor': '' })),
      );
    }
    try {
      const { rerender } = render(createElement(Older, { fetching: false }));
      const el = screen.getByTestId('thread');
      top.value = 80; // near the top, where an older page is requested
      request.current?.();
      rerender(createElement(Older, { fetching: true }));

      // The reader moves while the page is out, then it lands with 2000px of history above.
      top.value = scenario.scrollTo;
      for (const [id, y] of [...messageTops]) messageTops.set(id, y + 2000);
      height += 2000;
      rerender(createElement(Older, { fetching: false }));

      assert.equal(el.scrollTop, scenario.expected, `the reader ended at ${el.scrollTop}`);
    } finally {
      for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
        if (saved[key]) Object.defineProperty(proto, key, saved[key]);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
      window.Element.prototype.getBoundingClientRect = rectSaved;
    }
  });
}

// ── Live messages and the per-chat position memory ───────────────────────────
// One container whose geometry the test drives: `height` is what its content measures and `top` what a
// browser would report, clamped to the content.

type Geometry = { height: number; top: number };

function installGeometry(state: Geometry): () => void {
  const maxTop = () => Math.max(0, state.height - CLIENT_HEIGHT);
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => state.height },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => Math.min(state.top, maxTop()),
      set: (v: number) => {
        state.top = Math.max(0, Math.min(v, maxTop()));
      },
    },
  });
  return () => {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
}

// What the last commit's hook call returned: the callbacks a page would hand to its components.
const hookRef: MutableRefObject<ReturnType<typeof useChatScrollPosition> | null> = { current: null };
const hook = (): ReturnType<typeof useChatScrollPosition> =>
  hookRef.current as ReturnType<typeof useChatScrollPosition>;

function Probe({ chatId, loaded = chatId !== null }: { chatId: string | null; loaded?: boolean }) {
  const result = useChatScrollPosition(chatId, loaded, false);
  useEffect(() => {
    hookRef.current = result;
  });
  return createElement('div', { ref: result.containerRef, 'data-testid': 'thread' });
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** The reader moves the thread: the position changes, then the browser reports it. */
function readerScrollsTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  rtl.fireEvent.scroll(el);
}

/**
 * A live message of `rowPx` the way the Chats page delivers one: announced to the hook while the thread
 * still has the height it had, then committed, then a frame.
 */
async function liveMessage(
  state: Geometry,
  rerender: (ui: ReturnType<typeof createElement>) => void,
  direction: 'incoming' | 'outgoing',
  rowPx: number,
  chatId = 'A',
): Promise<void> {
  hook().onMessageAppended(direction);
  state.height += rowPx;
  rerender(createElement(Probe, { chatId }));
  await nextFrame();
}

test('a chat left at the bottom comes back at its newest message when more arrived while the reader was elsewhere', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000);
    readerScrollsTo(el, g.height - CLIENT_HEIGHT); // the reader leaves A at its bottom

    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    g.height = 5200; // while they read B, two messages reached A's cached thread
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'chat A came back above the messages that arrived');
  } finally {
    restore();
  }
});

test('a chat left at the bottom comes back at the bottom after live messages followed it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el); // the event for the write that opened the chat at its bottom
    // The reader goes up a little and back down, so the position is remembered by genuine scrolls.
    readerScrollsTo(el, 3000);
    readerScrollsTo(el, g.height - CLIENT_HEIGHT);

    await liveMessage(g, rerender, 'incoming', 300);
    await liveMessage(g, rerender, 'incoming', 300);
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the thread did not follow the live messages');

    g.height = 4600; // chat B has a thread of its own
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    g.height = 5200; // chat A again, its cached thread holding both messages
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'chat A came back above its newest messages');
  } finally {
    restore();
  }
});

// Between the pin threshold (24px) and the follow threshold (100px) the reader is not pinned but a live message
// still scrolls the thread, and the position remembered for the chat is then the one before the message.
test('a chat left just above the bottom comes back at the bottom after a live message followed it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, g.height - CLIENT_HEIGHT - 60);

    await liveMessage(g, rerender, 'incoming', 300);
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the thread did not follow the live message');

    g.height = 4600;
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    g.height = 4900;
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'chat A came back above its newest message');
  } finally {
    restore();
  }
});

test('a chat left mid-thread comes back where the reader left it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000);

    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, 3000);
  } finally {
    restore();
  }
});

// ── Which scroll events are the reader's ─────────────────────────────────────
// A browser reports at most one scroll event per frame, however many writes the frame held, and reports the
// clamp a content swap causes as one too. None of that is the reader moving the thread.

test('a restore keeps its pending position through the scroll event the content swap raised', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000); // the reader's spot in A
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    readerScrollsTo(el, 4200); // B is left at its bottom

    // Back to A, whose images have not decoded: the cached thread is short, so the browser clamps the offset B
    // left and reports it. The restore write finds the thread already there and moves nothing.
    g.height = 2000;
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);

    g.height = 4600; // the images decode
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'the saved spot was lost to the clamp');
  } finally {
    restore();
  }
});

test('decodes that share a frame do not turn their one scroll event into the reader scrolling', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000);
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    readerScrollsTo(el, 300);

    g.height = 2000; // A again, its images not decoded
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);

    // Two images decode in one frame. The first write moves the thread; the second finds it where the first
    // left it. The browser reports the frame as a single event.
    g.height = 3200;
    hook().onMediaLoad();
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 2800);
    fireEvent.scroll(el);

    g.height = 4600; // the rest decode
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000, "the saved spot was lost to the frame's scroll event");
  } finally {
    restore();
  }
});

test('a reader scrolling back to where a pin left the thread is still the reader', async () => {
  const { render, screen, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 4200 }; // already at the bottom, so the opening pin moves nothing
  const restore = installGeometry(g);
  try {
    render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    readerScrollsTo(el, 3000);
    readerScrollsTo(el, 4200); // exactly where the pin left it: the reader's scroll, which pins the thread again

    g.height = 4900; // an image decodes below
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 4500, 'a reader at the bottom was not kept there');
  } finally {
    restore();
  }
});

// ── Following a live message ─────────────────────────────────────────────────
// The Chats page announces a message when it writes it to the cache, and the row reaches the DOM after the cache
// notifies its observers and React renders, which a frame can overtake.

test('a live message is followed by the commit that adds its row, even when a frame ran first', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);

    hook().onMessageAppended('incoming');
    await nextFrame(); // a frame lands before the commit: the thread has not grown yet
    rerender(createElement(Probe, { chatId: 'A' })); // so does a commit of something else, the sidebar
    g.height += 300;
    rerender(createElement(Probe, { chatId: 'A' })); // the row
    await nextFrame();
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the newest message was left below the fold');
  } finally {
    restore();
  }
});

test('a reader who scrolled away before the row was committed is not pulled back down', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);

    hook().onMessageAppended('incoming');
    readerScrollsTo(el, 3000);
    await nextFrame();
    g.height += 300;
    rerender(createElement(Probe, { chatId: 'A' }));
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'the reader was taken to the bottom');
  } finally {
    restore();
  }
});

test('a message announced in a chat that was left before its row committed pins nothing in the next chat', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    readerScrollsTo(el, 4140); // the spot the reader left in B, just above its bottom
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);

    hook().onMessageAppended('incoming');
    rerender(createElement(Probe, { chatId: 'B' })); // the reader goes back to B before the row lands
    fireEvent.scroll(el);
    g.height += 300; // B's thread grows for a reason of its own
    rerender(createElement(Probe, { chatId: 'B' }));
    await nextFrame();
    assert.equal(el.scrollTop, 4140, "the other chat's message moved the reader's spot in B");
  } finally {
    restore();
  }
});

test('a message the reader is far from the bottom of leaves their position alone', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 1000);

    await liveMessage(g, rerender, 'incoming', 300);
    assert.equal(el.scrollTop, 1000);
  } finally {
    restore();
  }
});

test('a message the reader sent always scrolls the thread to it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 1000);

    await liveMessage(g, rerender, 'outgoing', 300);
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT);
  } finally {
    restore();
  }
});

test('a message announced while its chat is still loading does not override where the chat opens', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000); // the spot the reader left in A
    rerender(createElement(Probe, { chatId: null }));

    // A is opened again from a cold cache: a spinner, then the thread. The message arrives in between.
    g.height = CLIENT_HEIGHT;
    rerender(createElement(Probe, { chatId: 'A', loaded: false }));
    hook().onMessageAppended('incoming');
    g.height = 4900;
    rerender(createElement(Probe, { chatId: 'A', loaded: true }));
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'the message took the reader from the spot they left');
  } finally {
    restore();
  }
});

// ── Media decoding ───────────────────────────────────────────────────────────
// Media has no box before it decodes, so a thread grows after it was positioned.

test('a saved position is applied again on each decode until the reader scrolls', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000);
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);

    g.height = 2000; // back to A before its media has decoded: the thread is short, and the spot out of reach
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 1600);

    g.height = 2600; // the first decodes: the spot is still out of reach
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 2200);
    fireEvent.scroll(el);

    g.height = 4600; // the rest: the spot is reached
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000);
    fireEvent.scroll(el);

    readerScrollsTo(el, 2000); // the reader moves: the spot is theirs to leave
    g.height = 4900;
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 2000, 'a decode took the reader back to the spot they left');
  } finally {
    restore();
  }
});

test('a thread pinned to the bottom stays there as media decodes, until the reader scrolls away', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 4200);

    g.height = 5000;
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 4600, 'a decode left the newest message below the fold');
    fireEvent.scroll(el);

    readerScrollsTo(el, 3000);
    g.height = 5400;
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'a decode pulled a reader who scrolled up back to the bottom');
  } finally {
    restore();
  }
});
