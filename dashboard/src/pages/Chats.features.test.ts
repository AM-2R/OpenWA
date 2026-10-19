// Render tests for what the chat page offers beyond its data flow, which Chats.test.ts covers: the quick
// filters, the new-chat panel, and the chat row actions with their dialogs, each with its wire effect. The page is wrapped in the providers
// App.tsx uses and the backend is stubbed at the fetch layer; runs under the bare `node --test` runner.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session, Chat } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// A second connected account, served when a test turns `listSecond` on. Its routes answer with the first
// session's fixtures, so both list the same chats: the shared chat id a late result must not cross over.
const SECOND_SESSION: Session = { ...SESSION, id: 'session-3', name: 'Second', phone: '15559876543' };
let listSecond = false;

// Responses a test holds back until it releases them, by route name.
const gates = new Map<string, Promise<void>>();
function hold(name: string): () => void {
  let release!: () => void;
  gates.set(name, new Promise<void>(resolve => (release = resolve)));
  return release;
}
// When true, the chat and contact writes answer HTTP 200 with `{ success: false }`, as an engine that
// declined to act does.
let declineWrites = false;

const CHAT: Chat = {
  id: '15550001111@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  lastMessage: 'hello from alice',
  archived: false,
  pinned: false,
  muted: false,
};

// A group the account administers, served only when a test turns `listGroup` on.
const GROUP: Chat = {
  ...({} as Chat),
  id: '120363000000000001@g.us',
  name: 'Team',
  isGroup: true,
  kind: 'group',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  lastMessage: 'hello team',
  archived: false,
  pinned: false,
  muted: false,
};
let listGroup = false;
// The contacts the session's blocklist holds.
let blockedIds: string[] = [];
// Whether the session's own number administers GROUP.
let groupAdmin = true;

const CONTACT = { id: '15550002222@c.us', name: 'Bob', number: '15550002222', isMyContact: true, isBlocked: false };
const ALICE_CONTACT = { id: CHAT.id, name: 'Alice', number: '15550001111', isMyContact: true, isBlocked: false };

// Served when a test turns `listExtra` on: a contact Baileys knows by push name only, listed as Baileys
// lists it (a bare push name, no `~`, `isMyContact: false`), and a chat keyed by a privacy id.
const PUSH_ONLY_CHAT: Chat = { ...CHAT, id: '628222@s.whatsapp.net', name: 'Bobby', lastMessage: 'hi' };
const PUSH_ONLY_CONTACT = {
  id: PUSH_ONLY_CHAT.id,
  pushName: 'Bobby',
  number: '628222',
  isMyContact: false,
  isBlocked: false,
};
const LID_CHAT: Chat = { ...CHAT, id: '262813461250071@lid', name: 'Lia', lastMessage: 'from a lid' };
let listExtra = false;
// The number the new-chat tests type, and the id the gateway resolves it to.
const TYPED_NUMBER = '+1 555 000 9999';
const RESOLVED_ID = '15550009999@c.us';
const GROUP_ID = '120363000000000000@g.us';

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

const fetchCalls: FetchCall[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const rawPath = url.replace(/^https?:\/\/[^/]+/, '');
    const path = rawPath.replace(`/api/sessions/${SECOND_SESSION.id}/`, `/api/sessions/${SESSION.id}/`);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, path: rawPath, body });
    const base = `/api/sessions/${SESSION.id}`;
    const gated = (name: string, response: () => Response) =>
      gates.get(name)?.then(response) ?? Promise.resolve(response());

    if (method === 'GET' && path === '/api/sessions') {
      return Promise.resolve(jsonResponse([SESSION, ...(listSecond ? [SECOND_SESSION] : [])]));
    }
    if (method === 'GET' && path.startsWith(`${base}/chats?`)) {
      return Promise.resolve(
        jsonResponse([CHAT, ...(listGroup ? [GROUP] : []), ...(listExtra ? [PUSH_ONLY_CHAT, LID_CHAT] : [])]),
      );
    }
    const groupPath = `${base}/groups/${encodeURIComponent(GROUP.id)}`;
    if (method === 'GET' && path === groupPath) {
      return Promise.resolve(
        jsonResponse({
          id: GROUP.id,
          name: GROUP.name,
          description: 'old description',
          locked: true,
          participants: [
            { id: `${SESSION.phone}@c.us`, number: SESSION.phone, isAdmin: groupAdmin, isSuperAdmin: false },
            { id: '15550002222@c.us', number: '15550002222', name: 'Bob', isAdmin: false, isSuperAdmin: false },
          ],
        }),
      );
    }
    if (method === 'GET' && path === `${base}/contacts/blocked`) return Promise.resolve(jsonResponse(blockedIds));
    // Writes that answer an acknowledgement: group edits, chat state changes, clearing and deleting a chat,
    // and the contact writes (block, unblock, save).
    const pinRoute = method === 'POST' && path.endsWith('/chats/pin');
    if (pinRoute) return gated('pin', () => jsonResponse({ success: !declineWrites }));
    if (
      (method === 'POST' && /\/chats\/(archive|pin|mute)$/.test(path)) ||
      (/\/contacts\/[^/]+\/block$/.test(path) && method !== 'GET') ||
      (method === 'PUT' && /\/contacts\/[^/]+$/.test(path))
    ) {
      return Promise.resolve(jsonResponse({ success: !declineWrites }));
    }
    if (
      (method === 'POST' && (path === `${base}/chats/unread` || path === `${base}/chats/delete`)) ||
      (method === 'DELETE' && /\/chats\/[^/]+\/messages$/.test(path))
    ) {
      return Promise.resolve(jsonResponse({ success: !declineWrites }));
    }
    if (path.startsWith(`${groupPath}/`)) {
      return Promise.resolve(jsonResponse({ success: true, message: 'ok' }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts/profile-pictures`)) {
      return Promise.resolve(jsonResponse({ pictures: {} }));
    }
    if (method === 'GET' && /\/contacts\/[^/]+\/profile-picture$/.test(path)) {
      return Promise.resolve(jsonResponse({ url: null }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts/check/`)) {
      return gated('check', () => jsonResponse({ exists: true, whatsappId: RESOLVED_ID }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts?`)) {
      return Promise.resolve(jsonResponse([ALICE_CONTACT, CONTACT, ...(listExtra ? [PUSH_ONLY_CONTACT] : [])]));
    }
    if (method === 'GET' && path.startsWith(`${base}/messages?`)) {
      return Promise.resolve(jsonResponse({ messages: [], total: 0 }));
    }
    if (method === 'GET' && /\/messages\/[^/]+\/history/.test(path)) return Promise.resolve(jsonResponse([]));
    if (method === 'POST' && path === `${base}/chats/read`) return gated('read', () => jsonResponse({ success: true }));
    if (method === 'POST' && path === `${base}/groups`) {
      return gated('createGroup', () => jsonResponse({ id: GROUP_ID, name: (body as { name: string }).name }, 201));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
// Every client a test rendered with: a test that renders twice must not leave the first one's gc timers behind,
// which hold the process open.
const queryClients: QueryClient[] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

afterEach(async () => {
  rtl.cleanup();
  resetSocketDouble();
  for (const client of queryClients.splice(0)) {
    await client.cancelQueries();
    client.clear();
  }
  fetchCalls.length = 0;
  listSecond = false;
  listExtra = false;
  declineWrites = false;
  gates.clear();
  listGroup = false;
  groupAdmin = true;
  blockedIds = [];
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'baileys');
});

/** Renders the page; `reactStrictMode` replays effect setup and cleanup as `main.tsx` does in development. */
function renderPage({ reactStrictMode = false } = {}): ReturnType<RTL['render']> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  queryClients.push(queryClient);
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
    { reactStrictMode },
  );
}

test('a read-only key is offered no new chat', async () => {
  const { screen } = rtl;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  renderPage();
  await screen.findByText('Alice');
  assert.ok(!screen.queryByRole('button', { name: 'New chat' }), 'a viewer key was offered a new chat');
});

test('a quick filter that matches no chat says so instead of claiming the account has none', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Groups' }));
  assert.ok(screen.getByText('No chats match this filter'));
  assert.ok(!screen.queryByText('Alice'), 'the filter left a 1:1 chat in the groups list');
});

for (const reactStrictMode of [false, true]) {
  test(`a typed number is checked with the gateway and opens a chat under the id it resolves to${reactStrictMode ? ' (StrictMode)' : ''}`, async () => {
    const { screen, fireEvent, waitFor, within } = rtl;
    const { container } = renderPage({ reactStrictMode });
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
      target: { value: TYPED_NUMBER },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Start chat with/ }));

    await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the new chat did not open'));
    assert.ok(
      fetchCalls.some(c => c.method === 'GET' && c.path === `/api/sessions/${SESSION.id}/contacts/check/15550009999`),
      'the number was not checked with the gateway',
    );
    await within(container.querySelector('.room-header') as HTMLElement).findByText('15550009999');
    assert.ok(!container.querySelector('.new-chat-panel'), 'the panel stayed open over the list');
  });
}

for (const reactStrictMode of [false, true]) {
  test(`a group is created with the picked contacts on Baileys, and whatsapp-web.js is not offered one${reactStrictMode ? ' (StrictMode)' : ''}`, async () => {
    const { screen, fireEvent, waitFor, within } = rtl;
    const { container } = renderPage({ reactStrictMode });
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Team' } });
    fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the new group did not open'));
    const create = fetchCalls.find(c => c.method === 'POST' && c.path === `/api/sessions/${SESSION.id}/groups`);
    assert.deepEqual(create?.body, { name: 'Team', participants: [CONTACT.id] });
    await within(container.querySelector('.room-header') as HTMLElement).findByText('Team');
    rtl.cleanup();

    window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
    renderPage({ reactStrictMode });
    await screen.findByText('Alice');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await screen.findByText('Bob');
    assert.ok(
      !screen.queryByRole('button', { name: 'New group' }),
      'whatsapp-web.js, which answers 501, offered a group',
    );
  });
}

test('a group row offers its actions, and marking it unread badges the row', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  // Group and 1:1 rows both carry the chevron.
  assert.equal(screen.getAllByRole('button', { name: /^Actions for/ }).length, 2);
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Mark as unread' }));

  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.method === 'POST' && c.path === `/api/sessions/${SESSION.id}/chats/unread`),
      'the gateway was not asked to mark the chat unread',
    ),
  );
  assert.deepEqual(fetchCalls.find(c => c.path === `/api/sessions/${SESSION.id}/chats/unread`)?.body, {
    chatId: GROUP.id,
  });
  await screen.findByLabelText('Marked as unread');
});

test('leaving a group asks in a dialog first, and only its confirm button tells the gateway', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  const leavePath = `/api/sessions/${SESSION.id}/groups/${encodeURIComponent(GROUP.id)}/leave`;

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave group' }));
  let dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('Leave the group "Team"?'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  assert.ok(!screen.queryByRole('dialog'), 'Cancel left the dialog open');
  assert.ok(!fetchCalls.some(c => c.path === leavePath), 'Cancel left the group');

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Leave group' }));
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.method === 'POST' && c.path === leavePath),
      'not left',
    ),
  );
  await waitFor(() => assert.ok(!screen.queryByRole('dialog'), 'the dialog stayed open after leaving'));
});

test('the group dialog saves a new name through the subject route and renames the row', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));

  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`Managed via ${SESSION.name}`);
  fireEvent.change(within(dialog).getByDisplayValue('Team'), { target: { value: 'Team Nord' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

  await waitFor(() =>
    assert.deepEqual(
      fetchCalls.find(c => c.path === `/api/sessions/${SESSION.id}/groups/${encodeURIComponent(GROUP.id)}/subject`)
        ?.body,
      { subject: 'Team Nord' },
    ),
  );
  // The description was not touched, so its route is not called.
  assert.ok(!fetchCalls.some(c => c.path.endsWith('/description')), 'an unchanged description was saved');
  await waitFor(() => assert.ok(screen.getAllByText('Team Nord').length > 0, 'the row kept the old name'));

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  assert.ok(within(dialog).getByText('Bob'));
  assert.ok(within(dialog).getByRole('button', { name: 'Remove: Bob' }), 'an admin was offered no member actions');
});

test('a member who is no admin sees the group read-only, and a viewer key gets no write actions', async () => {
  const { screen, fireEvent, within } = rtl;
  listGroup = true;
  groupAdmin = false;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  renderPage();
  await screen.findByText('Team');
  // Every 1:1 action writes, so a viewer's 1:1 row carries no menu at all.
  assert.ok(!screen.queryByRole('button', { name: 'Actions for Alice' }), 'a viewer was offered 1:1 actions');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  assert.ok(!screen.queryByRole('button', { name: 'Mark as unread' }), 'a viewer was offered mark-as-unread');
  assert.ok(!screen.queryByRole('button', { name: 'Leave group' }), 'a viewer was offered leaving the group');
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));

  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`Not an admin via ${SESSION.name}`);
  assert.ok((within(dialog).getByDisplayValue('Team') as HTMLInputElement).disabled, 'the name is editable');
  assert.ok((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled);
});

test('a 1:1 row clears its chat and deletes it on whatsapp-web.js, each only after its own confirmation', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  renderPage();
  await screen.findByText('Alice');
  const chatPath = `/api/sessions/${SESSION.id}/chats`;

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  // A 1:1 row has no group actions.
  assert.ok(!screen.queryByRole('button', { name: 'Group info' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }));
  let dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('Delete every message in the chat with Alice?'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }));
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.method === 'DELETE' && c.path === `${chatPath}/${encodeURIComponent(CHAT.id)}/messages`),
      'the chat was not cleared',
    ),
  );
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.ok(screen.getByText('Alice'), 'clearing removed the chat from the list');

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }));
  await waitFor(() =>
    assert.deepEqual(fetchCalls.find(c => c.method === 'POST' && c.path === `${chatPath}/delete`)?.body, {
      chatId: CHAT.id,
    }),
  );
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the deleted chat stayed in the list'));
});

/** Open a row's chevron menu and pick one of its actions. */
function pickRowAction(name: string, action: string): void {
  const { screen, fireEvent } = rtl;
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(screen.getByRole('button', { name: action }));
}

test("a row's menu sits fixed above the list, and scrolling the list closes it", async () => {
  const { screen, fireEvent } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  const popover = container.querySelector('.chat-row-menu-popover') as HTMLElement;
  assert.equal(popover.style.position, 'fixed', 'the menu can be clipped by the scrolling list');
  fireEvent.scroll(popover.closest('.chat-item-wrap')?.parentElement as HTMLElement);
  assert.equal(container.querySelector('.chat-row-menu-popover'), null, 'the menu stayed open, adrift from its row');
});

test('archiving a chat moves it into the archive view, and unarchiving brings it back', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Archive chat');
  await waitFor(() =>
    assert.deepEqual(fetchCalls.find(c => c.path === `/api/sessions/${SESSION.id}/chats/archive`)?.body, {
      chatId: CHAT.id,
      archive: true,
    }),
  );
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the archived chat stayed in the main list'));

  fireEvent.click(screen.getByRole('button', { name: /^Archived/ }));
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Unarchive chat');
  await waitFor(() => assert.ok(!screen.queryByText('Alice'), 'the unarchived chat stayed in the archive view'));
  fireEvent.click(screen.getByRole('button', { name: 'Archived chats' }));
  await screen.findByText('Alice');
});

test('a pinned chat leads the list with a pin, and a muted one carries the mute it was given', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const { container } = renderPage();
  await screen.findByText('Team');

  pickRowAction('Team', 'Pin chat');
  await waitFor(() =>
    assert.equal(container.querySelector('.chats-list .chat-item-name')?.textContent, 'Team', 'not pinned first'),
  );
  assert.ok(screen.getByRole('img', { name: 'Pinned' }));

  pickRowAction('Alice', 'Mute notifications');
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByLabelText('Always'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Mute notifications' }));
  await waitFor(() =>
    assert.deepEqual(fetchCalls.find(c => c.path === `/api/sessions/${SESSION.id}/chats/mute`)?.body, {
      chatId: CHAT.id,
      muteUntil: Date.UTC(2100, 0, 1),
    }),
  );
  await screen.findByRole('img', { name: 'Muted' });
});

test('blocking a contact asks first, and the menu then offers to unblock it', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Block contact');
  const dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('Block Alice?'));
  blockedIds = [CHAT.id];
  fireEvent.click(within(dialog).getByRole('button', { name: 'Block contact' }));
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(
        c =>
          c.method === 'POST' && c.path === `/api/sessions/${SESSION.id}/contacts/${encodeURIComponent(CHAT.id)}/block`,
      ),
      'the contact was not blocked',
    ),
  );
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Unblock contact' });
});

test('saving a contact sends its name to the address book and renames the row', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Rename contact');
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Alice' } });
  fireEvent.change(within(dialog).getByLabelText('Last name (optional)'), { target: { value: 'Smith' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    assert.deepEqual(
      fetchCalls.find(
        c => c.method === 'PUT' && c.path === `/api/sessions/${SESSION.id}/contacts/${encodeURIComponent(CHAT.id)}`,
      )?.body,
      { firstName: 'Alice', lastName: 'Smith' },
    ),
  );
  await screen.findByText('Alice Smith');
});

// ── Review regressions: late results stay with their session, declined writes change nothing, and the
// address book decides what is saved and what can be. ──

/** Switch to another session through the page's session selector. */
function switchSession(container: HTMLElement, id: string): void {
  rtl.fireEvent.change(container.querySelector('select.session-selector') as HTMLSelectElement, {
    target: { value: id },
  });
}

const settle = async () => {
  await rtl.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

test('a number lookup that answers after the panel closed and the session changed opens nothing', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const release = hold('check');
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
    target: { value: TYPED_NUMBER },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Start chat with/ }));
  await waitFor(() =>
    assert.ok(
      fetchCalls.some(c => c.path.includes('/contacts/check/')),
      'no lookup was made',
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  switchSession(container, SECOND_SESSION.id);
  await waitFor(() =>
    assert.equal((container.querySelector('select.session-selector') as HTMLSelectElement).value, SECOND_SESSION.id),
  );
  release();
  await settle();

  assert.equal(container.querySelector('.room-header'), null, "A's lookup opened a chat on B");
  assert.ok(!screen.queryByText('15550009999'), "A's lookup added a row to B's list");
});

test('a group created after the session changed is not opened on the new session', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listSecond = true;
  const release = hold('createGroup');
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.click(screen.getByRole('button', { name: 'New group' }));
  fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Late team' } });
  fireEvent.click(await screen.findByRole('button', { name: /Bob/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'POST' && c.path.endsWith('/groups'))));

  // Back to the new-chat view, Back again out of the panel, then to the other session.
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => assert.equal(container.querySelector('.new-chat-panel'), null, 'the panel stayed open'));
  switchSession(container, SECOND_SESSION.id);
  await waitFor(() =>
    assert.equal((container.querySelector('select.session-selector') as HTMLSelectElement).value, SECOND_SESSION.id),
  );
  release();
  await settle();

  assert.equal(container.querySelector('.room-header'), null, 'the new group opened on the other session');
  assert.ok(!screen.queryByText('Late team'), "the group was added to the other session's list");
});

test("a pin that answers after a switch does not pin the other session's chat with the same id", async () => {
  const { screen, waitFor } = rtl;
  listSecond = true;
  const release = hold('pin');
  const { container } = renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Pin chat');
  await waitFor(() => assert.ok(fetchCalls.some(c => c.path === `/api/sessions/${SESSION.id}/chats/pin`)));

  // Both sessions list Alice under the same chat id.
  switchSession(container, SECOND_SESSION.id);
  await waitFor(() =>
    assert.equal((container.querySelector('select.session-selector') as HTMLSelectElement).value, SECOND_SESSION.id),
  );
  await screen.findByText('Alice');
  release();
  await settle();

  assert.ok(!screen.queryByRole('img', { name: 'Pinned' }), "B's row was pinned by A's late answer");
});

test('a clear or delete the engine declines keeps the chat and its dialog, and says it failed', async () => {
  const { screen, fireEvent, within } = rtl;
  declineWrites = true;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  renderPage();
  await screen.findByText('Alice');

  pickRowAction('Alice', 'Clear chat');
  let dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear chat' }));
  await screen.findByText('Could not clear the chat');
  assert.ok(screen.getByRole('dialog'), 'the dialog closed on a declined clear');
  assert.ok(screen.getAllByText('hello from alice').length > 0, 'the preview was cleared although nothing was');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  pickRowAction('Alice', 'Delete chat');
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete chat' }));
  await screen.findByText('Could not delete the chat');
  assert.ok(screen.getByRole('dialog'), 'the dialog closed on a declined delete');
  assert.ok(screen.getAllByText('Alice').length > 0, 'the row was removed although the chat was not');
});

test('a mark-as-unread the engine declines leaves the row read', async () => {
  const { screen } = rtl;
  declineWrites = true;
  renderPage();
  await screen.findByText('Alice');
  pickRowAction('Alice', 'Mark as unread');
  await screen.findByText('Could not mark the chat as unread');
  assert.ok(!screen.queryByLabelText('Marked as unread'), 'the row was badged although the chat was not marked');
});

test('a contact Baileys knows by push name only is unsaved: Unknown lists it, and its menu offers Save', async () => {
  const { screen, fireEvent } = rtl;
  listExtra = true;
  renderPage();
  await screen.findByText('Bobby');

  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
  assert.ok(screen.getByText('Bobby'), 'the push-name-only contact left the Unknown filter');
  assert.ok(!screen.queryByText('Alice'), 'a saved contact is listed as unknown');

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Bobby' }));
  assert.ok(screen.getByRole('button', { name: /^Save contact/ }));
  assert.ok(!screen.queryByRole('button', { name: /^Rename contact/ }), 'an unsaved contact is offered Rename');
});

test('a chat keyed by a privacy id offers Save contact disabled, with the reason, and sends nothing', async () => {
  const { screen, fireEvent } = rtl;
  listExtra = true;
  renderPage();
  await screen.findByText('Lia');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Lia' }));
  const save = screen.getByRole('button', { name: /^Save contact/ }) as HTMLButtonElement;
  assert.equal(save.disabled, true, 'Save is offered for a @lid chat');
  assert.match(save.textContent ?? '', /privacy id \(@lid\)/);
  fireEvent.click(save);
  assert.ok(!screen.queryByRole('dialog'), 'the save dialog opened for a @lid chat');
  assert.ok(!fetchCalls.some(c => c.method === 'PUT' && c.path.includes('/contacts/')), 'a @lid id was sent');
});

// ── Mark as unread against the automatic read the open room queues (MARK_READ_DEBOUNCE_MS later). ──

const readsOf = (chatId: string) =>
  fetchCalls.filter(
    c => c.path === `/api/sessions/${SESSION.id}/chats/read` && (c.body as { chatId?: string })?.chatId === chatId,
  );
const unreadIndex = (chatId: string) =>
  fetchCalls.findIndex(
    c => c.path === `/api/sessions/${SESSION.id}/chats/unread` && (c.body as { chatId?: string })?.chatId === chatId,
  );

test("Mark as unread drops the chat's queued automatic read, and another chat's queued read still goes out", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  listGroup = true;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Team'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the group did not open'));
  // Both reads are now queued: the group's from its opening, Alice's from hers.
  fireEvent.click(screen.getByText('Alice'));
  pickRowAction('Alice', 'Mark as unread');

  await waitFor(() => assert.equal(readsOf(GROUP.id).length, 1, "the other chat's queued read was dropped"), {
    timeout: 3_000,
  });
  await waitFor(() => assert.ok(unreadIndex(CHAT.id) >= 0, 'the unread mark was not sent'));
  await settle();
  assert.deepEqual(readsOf(CHAT.id), [], 'the queued read went out and undid the unread mark');
});

test('Mark as unread waits for an automatic read already sent, so the unread mark is the last request', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const release = hold('read');
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'the automatic read was not sent'), {
    timeout: 3_000,
  });

  pickRowAction('Alice', 'Mark as unread');
  await settle();
  assert.equal(unreadIndex(CHAT.id), -1, 'the unread mark went out while the read was still in flight');

  release();
  await waitFor(() => assert.ok(unreadIndex(CHAT.id) >= 0, 'the unread mark was not sent'));
  const readIndex = fetchCalls.indexOf(readsOf(CHAT.id)[0]);
  assert.ok(readIndex < unreadIndex(CHAT.id), 'the read was not ordered before the unread mark');
  assert.equal(readsOf(CHAT.id).length, 1, 'another automatic read followed the unread mark');
});

test('on Baileys neither the row nor the room menu offers Clear chat or Delete chat (#1891)', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  assert.ok(screen.getByRole('button', { name: 'Archive chat' }), 'the row menu did not open');
  assert.ok(!screen.queryByRole('button', { name: 'Clear chat' }), 'the row menu offered Clear chat');
  assert.ok(!screen.queryByRole('button', { name: 'Delete chat' }), 'the row menu offered Delete chat');
  fireEvent.keyDown(document, { key: 'Escape' });

  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  const menu = container.querySelector('.room-menu-popover') as HTMLElement;
  assert.ok(within(menu).getByRole('button', { name: 'Copy chat ID' }), 'the room menu did not open');
  assert.ok(!within(menu).queryByRole('button', { name: 'Clear chat' }), 'the room menu offered Clear chat');
  assert.ok(!within(menu).queryByRole('button', { name: 'Delete chat' }), 'the room menu offered Delete chat');
});
