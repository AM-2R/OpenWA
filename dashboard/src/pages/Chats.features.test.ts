// Render tests for what the chat page offers beyond its data flow, which Chats.test.ts covers: the quick
// filters, the new-chat panel, and the chat row actions with their dialogs, each with its wire effect. The page is wrapped in the providers
// App.tsx uses and the backend is stubbed at the fetch layer; runs under the bare `node --test` runner.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import type { Session, Chat } from '../services/api';
import { lastSocket, resetSocketDouble } from '../test-helpers/socket-io-double.ts';

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
// The profile pictures the batch route serves, by chat id; an id with none answers null.
const pictureFor: Record<string, string> = {};

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
// GROUP as the server holds it: the group routes read and write these.
let groupName = GROUP.name;
let groupDescription = 'old description';
let bobIsAdmin = false;
// When true, GROUP also lists a member WhatsApp knows by a privacy id only, which carries no phone number.
let groupHasLidMember = false;
// When true, a membership write answers HTTP 200 with its participants refused in `results`, as the route does
// for a batch WhatsApp turns down in part.
let refuseMember = false;

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
// A contact the address book holds as saved under a name that reads like a number.
const NUMBER_NAMED_CHAT: Chat = { ...CHAT, id: '15550003333@c.us', name: '+1 555 000 3333', lastMessage: 'hey' };
const NUMBER_NAMED_CONTACT = {
  id: NUMBER_NAMED_CHAT.id,
  name: NUMBER_NAMED_CHAT.name,
  number: '15550003333',
  isMyContact: true,
  isBlocked: false,
};
let listExtra = false;
// Served when a test turns `listDuplicateContact` on: Bob listed twice under one id, as whatsapp-web.js lists a
// contact it holds as both a LID and a phone record. The first copy carries another number than the id's.
const DUPLICATE_CONTACT = { ...CONTACT, number: '262813461250071' };
let listDuplicateContact = false;
// When true, the address book answers 503, as it does while the engine is busy.
let failContacts = false;
// What the chat list reports for Alice, which a test changes to stand for the phone changing her chat.
const aliceNow: Partial<Chat> = {};
// The messages the gateway holds for Alice's chat, oldest first.
let aliceThread: Array<Record<string, unknown>> = [];
const threadRow = (n: number, direction: 'incoming' | 'outgoing' = 'incoming') => ({
  id: `row-${n}`,
  waMessageId: `wamid.${direction === 'incoming' ? 'in' : 'out'}.${n}`,
  chatId: CHAT.id,
  from: direction === 'incoming' ? CHAT.id : 'me',
  to: direction === 'incoming' ? 'me' : CHAT.id,
  body: `message ${n}`,
  type: 'text',
  direction,
  status: 'sent',
  timestamp: 1_700_000_000 + n,
  createdAt: new Date((1_700_000_000 + n) * 1000).toISOString(),
});
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
        jsonResponse([
          { ...CHAT, ...aliceNow },
          ...(listGroup ? [GROUP] : []),
          ...(listExtra ? [PUSH_ONLY_CHAT, LID_CHAT, NUMBER_NAMED_CHAT] : []),
        ]),
      );
    }
    const groupPath = `${base}/groups/${encodeURIComponent(GROUP.id)}`;
    if (method === 'GET' && path === groupPath) {
      return Promise.resolve(
        jsonResponse({
          id: GROUP.id,
          name: groupName,
          description: groupDescription,
          locked: true,
          participants: [
            { id: `${SESSION.phone}@c.us`, number: SESSION.phone, isAdmin: groupAdmin, isSuperAdmin: false },
            { id: '15550002222@c.us', number: '15550002222', name: 'Bob', isAdmin: bobIsAdmin, isSuperAdmin: false },
            ...(groupHasLidMember
              ? [{ id: '262813461250071@lid', number: '262813461250071', isAdmin: false, isSuperAdmin: false }]
              : []),
          ],
        }),
      );
    }
    if (method === 'GET' && path === `${base}/contacts/blocked`) return Promise.resolve(jsonResponse(blockedIds));
    // Writes that answer an acknowledgement: chat state changes, clearing and deleting a chat, leaving a group
    // and the contact writes (block, unblock, save). A test can hold each back by its name.
    const writes: Array<[name: string, matches: boolean]> = [
      ['pin', method === 'POST' && path.endsWith('/chats/pin')],
      ['archive', method === 'POST' && path.endsWith('/chats/archive')],
      ['mute', method === 'POST' && path.endsWith('/chats/mute')],
      ['unread', method === 'POST' && path === `${base}/chats/unread`],
      ['deleteChat', method === 'POST' && path === `${base}/chats/delete`],
      ['clearChat', method === 'DELETE' && /\/chats\/[^/]+\/messages$/.test(path)],
      ['leave', method === 'POST' && path === `${groupPath}/leave`],
      ['block', method !== 'GET' && /\/contacts\/[^/]+\/block$/.test(path)],
      ['saveContact', method === 'PUT' && /\/contacts\/[^/]+$/.test(path)],
    ];
    const write = writes.find(([, matches]) => matches);
    if (write) return gated(write[0], () => jsonResponse({ success: !declineWrites }));
    if (path.startsWith(`${groupPath}/participants`)) {
      const { participants } = body as { participants: string[] };
      if (path.endsWith('/promote') && !refuseMember) bobIsAdmin = true;
      if (path.endsWith('/demote') && !refuseMember) bobIsAdmin = false;
      const refusal = refuseMember ? { status: 403, message: 'not-authorized' } : {};
      return Promise.resolve(
        jsonResponse({
          success: true,
          message: 'ok',
          results: participants.map(id => ({ id, success: !refuseMember, ...refusal })),
        }),
      );
    }
    if (path.startsWith(`${groupPath}/`)) {
      if (method === 'PUT' && path.endsWith('/subject')) groupName = (body as { subject: string }).subject;
      if (method === 'PUT' && path.endsWith('/description'))
        groupDescription = (body as { description: string }).description;
      return Promise.resolve(jsonResponse({ success: true, message: 'ok' }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts/profile-pictures`)) {
      const ids = decodeURIComponent(path.split('ids=')[1] ?? '')
        .split(',')
        .filter(Boolean);
      return Promise.resolve(
        jsonResponse({ pictures: Object.fromEntries(ids.map(id => [id, pictureFor[id] ?? null])) }),
      );
    }
    if (method === 'GET' && /\/contacts\/[^/]+\/profile-picture$/.test(path)) {
      return Promise.resolve(jsonResponse({ url: null }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts/check/`)) {
      return gated('check', () => jsonResponse({ exists: true, whatsappId: RESOLVED_ID }));
    }
    if (method === 'GET' && path.startsWith(`${base}/contacts?`)) {
      return gated('contacts', () =>
        failContacts
          ? jsonResponse({ message: 'busy' }, 503)
          : jsonResponse([
              ALICE_CONTACT,
              ...(listDuplicateContact ? [DUPLICATE_CONTACT] : []),
              CONTACT,
              ...(listExtra ? [PUSH_ONLY_CONTACT, NUMBER_NAMED_CONTACT] : []),
            ]),
      );
    }
    if (method === 'GET' && path.startsWith(`${base}/messages?`)) {
      // The gateway answers newest first.
      return gated('thread', () => jsonResponse({ messages: [...aliceThread].reverse(), total: aliceThread.length }));
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
  listDuplicateContact = false;
  failContacts = false;
  for (const key of Object.keys(aliceNow)) delete aliceNow[key as keyof Chat];
  aliceThread = [];
  declineWrites = false;
  for (const id of Object.keys(pictureFor)) delete pictureFor[id];
  gates.clear();
  listGroup = false;
  groupAdmin = true;
  groupName = GROUP.name;
  groupDescription = 'old description';
  bobIsAdmin = false;
  groupHasLidMember = false;
  refuseMember = false;
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

test('a contact the engine lists twice under one id is offered once, and found by its phone number', async () => {
  const { screen, fireEvent } = rtl;
  listDuplicateContact = true;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByRole('button', { name: /Bob/ });
  assert.equal(screen.getAllByRole('button', { name: /Bob/ }).length, 1, 'Bob was listed twice');

  fireEvent.change(screen.getByLabelText('Search name or number with country code'), {
    target: { value: CONTACT.number },
  });
  assert.equal(screen.getAllByRole('button', { name: /Bob/ }).length, 1, 'Bob was not found by his phone number');
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

/** Open Group info for Team and wait until the group has loaded. */
async function openGroupInfo(): Promise<HTMLElement> {
  const { screen, within } = rtl;
  await screen.findByText('Team');
  pickRowAction('Team', 'Group info');
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`Managed via ${SESSION.name}`);
  return dialog;
}

test('unsaved group edits survive a member action that reloads the group', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Typed' } });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin: Bob' }));
  await waitFor(() => within(dialog).getByRole('button', { name: 'Remove admin: Bob' }));

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Info' }));
  assert.equal((within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).value, 'Team Typed');
  assert.equal((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled, false);
  assert.ok(screen.getByRole('dialog'));
});

test('a group field that was not edited follows the group when it is loaded again', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Typed' } });
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));
  groupDescription = 'changed by another admin';
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin: Bob' }));
  await waitFor(() => within(dialog).getByRole('button', { name: 'Remove admin: Bob' }));

  fireEvent.click(within(dialog).getByRole('tab', { name: 'Info' }));
  assert.equal((within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).value, 'Team Typed');
  assert.equal((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value, 'changed by another admin');
});

test('Refresh in the group dialog drops the draft and shows the group as it is', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Typed' } });
  groupName = 'Team Renamed Elsewhere';
  fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
  await waitFor(() =>
    assert.equal((within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).value, 'Team Renamed Elsewhere'),
  );
});

test('a saved group edit leaves the form reading the saved group, with nothing left to save', async () => {
  const { fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.change(within(dialog).getByLabelText(/^Group name/), { target: { value: 'Team Nord' } });
  fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'new description' } });
  const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
  fireEvent.click(save);
  await waitFor(() => assert.equal(groupName, 'Team Nord'));
  await waitFor(() => assert.equal(save.disabled, true, 'the saved group still reads as changed'));
  assert.equal((within(dialog).getByLabelText(/^Group name/) as HTMLInputElement).value, 'Team Nord');
  assert.equal((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value, 'new description');
});

test('a group picture saved in the group dialog replaces the one on the sidebar row', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const objectUrls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => 'blob:picked';
  URL.revokeObjectURL = () => undefined;
  try {
    listGroup = true;
    pictureFor[GROUP.id] = 'https://cdn.example/old.jpg';
    const { container } = renderPage();
    await screen.findByText('Team');
    const rowPicture = () =>
      within(container.querySelector('.chats-list') as HTMLElement)
        .getByText('Team')
        .closest('.chat-item-card')
        ?.querySelector('img')
        ?.getAttribute('src');
    await waitFor(() => assert.equal(rowPicture(), 'https://cdn.example/old.jpg'));

    pickRowAction('Team', 'Group info');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(`Managed via ${SESSION.name}`);
    const file = new (window as unknown as { File: typeof File }).File(['x'], 'team.png', { type: 'image/png' });
    fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    await waitFor(() => assert.equal(save.disabled, false, 'the picked picture was not taken'));

    pictureFor[GROUP.id] = 'https://cdn.example/new.jpg';
    fireEvent.click(save);
    await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'PUT' && c.path.endsWith('/picture'))));
    await waitFor(() => assert.equal(rowPicture(), 'https://cdn.example/new.jpg', 'the row kept the old picture'));
  } finally {
    URL.createObjectURL = objectUrls.create;
    URL.revokeObjectURL = objectUrls.revoke;
  }
});

test('a member known only by a privacy id is not shown as a phone number', async () => {
  const { fireEvent, within } = rtl;
  listGroup = true;
  groupHasLidMember = true;
  renderPage();
  const dialog = await openGroupInfo();
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));

  const names = Array.from(dialog.querySelectorAll('.group-info-member .name')).map(name => name.textContent);
  // The digits of a privacy id are no phone number, so they are shown as they are and never grouped like one.
  assert.deepEqual(names, ['You', 'Bob', '262813461250071']);
  assert.ok(!(dialog.textContent ?? '').includes('+262'), 'a privacy id was formatted as an international number');
});

test('a participant the gateway refuses is reported although the write answered 200', async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  fireEvent.click(screen.getByRole('button', { name: 'Group info' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText(`Managed via ${SESSION.name}`);
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Participants' }));

  const writesTo = (action: string) => fetchCalls.filter(c => c.path.endsWith(`/participants/${action}`)).length;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make admin: Bob' }));
  await waitFor(() => assert.equal(writesTo('promote'), 1));
  // The accepted write made Bob an admin, so the row now offers the way back.
  await waitFor(() =>
    assert.ok(!(within(dialog).getByRole('button', { name: 'Remove admin: Bob' }) as HTMLButtonElement).disabled),
  );
  assert.ok(!screen.queryByText('The action failed'), 'an accepted write was reported as failed');

  refuseMember = true;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove admin: Bob' }));
  await screen.findByText('The action failed');
  await screen.findByText('15550002222: not-authorized');
  assert.equal(writesTo('demote'), 1);
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

/** Like pickRowAction, for an entry named by the address book, which the first menu to open has to read. */
async function pickRowActionOnceLoaded(name: string, action: string): Promise<void> {
  const { screen, fireEvent } = rtl;
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole('button', { name: action }));
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

/** The accessible name of the element that has focus: DOM nodes are compared by name, as a failed deepEqual on them hangs. */
const focusedName = () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName;

test("dismissing a dialog a row's menu opened returns focus to the row's menu button", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  const trigger = screen.getByRole('button', { name: 'Actions for Alice' });
  trigger.focus();
  fireEvent.click(trigger);
  const item = screen.getByRole('button', { name: 'Block contact' });
  item.focus();
  fireEvent.click(item);
  await screen.findByRole('dialog');

  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.equal(focusedName(), 'Actions for Alice', 'focus fell to the page');
});

test("dismissing a dialog the room's menu opened, or the menu itself, returns focus to its button", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  const trigger = container.querySelector('.room-menu-trigger') as HTMLButtonElement;

  trigger.focus();
  fireEvent.click(trigger);
  const item = within(container.querySelector('.room-menu-popover') as HTMLElement).getByRole('button', {
    name: 'Block contact',
  });
  item.focus();
  fireEvent.click(item);
  await screen.findByRole('dialog');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.equal(focusedName(), 'More actions', 'focus fell to the page after the dialog');

  fireEvent.click(trigger);
  within(container.querySelector('.room-menu-popover') as HTMLElement)
    .getByRole('button', { name: 'Copy chat ID' })
    .focus();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!container.querySelector('.room-menu-popover')));
  assert.equal(focusedName(), 'More actions', 'focus fell to the page after Escape');
});

test('a row menu stays open while the open thread scrolls, which does not move its row', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-messages'), 'the thread did not open'));
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  assert.ok(container.querySelector('.chat-row-menu-popover'), 'the menu did not open');

  // A message that arrives makes the open thread scroll to its end.
  fireEvent.scroll(container.querySelector('.room-messages') as HTMLElement);
  assert.ok(container.querySelector('.chat-row-menu-popover'), 'a scroll of the thread closed the menu');

  // The list the row sits in does move it.
  fireEvent.scroll(container.querySelector('.chats-list') as HTMLElement);
  assert.equal(container.querySelector('.chat-row-menu-popover'), null, 'the menu stayed open, adrift from its row');
});

test("a row's menu is placed by physical edges, so a right-to-left page keeps the position it computed", async () => {
  const { screen, fireEvent } = rtl;
  const { container } = renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  const popover = container.querySelector('.chat-row-menu-popover') as HTMLElement;
  assert.notEqual(popover.style.left, '', 'no horizontal position was set');
  // The stylesheet pins the end edge with inset-inline-end. Releasing it with that same logical property would,
  // right-to-left, release the left edge that was just set; the physical right edge is the one to release.
  assert.equal(popover.style.right, 'auto', 'the stylesheet still pins the popover by its end edge');
  assert.ok(!/inset-inline/.test(popover.getAttribute('style') ?? ''), 'a logical edge can undo the physical one');
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
  await pickRowActionOnceLoaded('Alice', 'Rename contact');
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

/** A dialog's confirming button, which loses its label to a spinner while its request is out. */
const confirmButton = (dialog: HTMLElement) =>
  dialog.querySelector('.modal-footer button:last-child') as HTMLButtonElement;

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

test("a dismissed block's late answer leaves the next confirmation open and enabled", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const release = hold('block');
  renderPage();
  await screen.findByText('Team');
  pickRowAction('Alice', 'Block contact');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Block contact' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'POST' && c.path.endsWith('/block'))));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));

  pickRowAction('Team', 'Leave group');
  const dialog = await screen.findByRole('dialog');
  assert.equal(confirmButton(dialog).disabled, false, "the block's busy state showed on the next dialog");
  release();
  await settle();
  assert.ok(screen.queryByRole('dialog'), "the block's answer closed the Leave dialog");
  assert.ok(!fetchCalls.some(c => c.path.endsWith('/leave')), 'the Leave dialog sent a request nobody asked for');
});

test("a dismissed mute's late answer leaves the next mute dialog open and enabled", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listGroup = true;
  const release = hold('mute');
  renderPage();
  await screen.findByText('Team');
  pickRowAction('Alice', 'Mute notifications');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Mute notifications' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'POST' && c.path.endsWith('/chats/mute'))));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));

  pickRowAction('Team', 'Mute notifications');
  const dialog = await screen.findByRole('dialog');
  assert.equal(confirmButton(dialog).disabled, false, "the first mute's busy state showed on the next dialog");
  release();
  await settle();
  assert.ok(screen.queryByRole('dialog'), "the first mute's answer closed the next dialog");
});

test("a dismissed contact save's late answer leaves the next save dialog open and enabled", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  listExtra = true;
  const release = hold('saveContact');
  renderPage();
  await screen.findByText('Bobby');
  await pickRowActionOnceLoaded('Alice', 'Rename contact');
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.ok(fetchCalls.some(c => c.method === 'PUT' && c.path.includes('/contacts/'))));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));

  pickRowAction('Bobby', 'Save contact');
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Robert' } });
  assert.equal(confirmButton(dialog).disabled, false, "the first save's busy state showed on the next dialog");
  release();
  await settle();
  assert.ok(screen.queryByRole('dialog'), "the first save's answer closed the next dialog");
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
  await screen.findByText('Bobby');
  assert.ok(!screen.queryByText('Alice'), 'a saved contact is listed as unknown');

  fireEvent.click(screen.getByRole('button', { name: 'Actions for Bobby' }));
  assert.ok(screen.getByRole('button', { name: /^Save contact/ }));
  assert.ok(!screen.queryByRole('button', { name: /^Rename contact/ }), 'an unsaved contact is offered Rename');
});

test("the contact dialog follows the address book the menu read, not the chat's name", async () => {
  const { screen, fireEvent, within } = rtl;
  listExtra = true;
  renderPage();
  await screen.findByText('Bobby');

  // Known to Baileys by a bare push name: unsaved, so Save, and the push name is no name to start from.
  pickRowAction('Bobby', 'Save contact');
  let dialog = await screen.findByRole('dialog');
  assert.equal(dialog.querySelector('h2')?.textContent, 'Save contact');
  assert.equal((within(dialog).getByLabelText('First name') as HTMLInputElement).value, '');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  // Saved under a name that reads like a number: Rename, with nothing to start from.
  await pickRowActionOnceLoaded('+1 555 000 3333', 'Rename contact');
  dialog = await screen.findByRole('dialog');
  assert.equal(dialog.querySelector('h2')?.textContent, 'Rename contact');
  assert.equal((within(dialog).getByLabelText('First name') as HTMLInputElement).value, '');
});

test("the contact dialog's Save button submits its form, so Enter in a name field saves", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  renderPage();
  await screen.findByText('Alice');
  await pickRowActionOnceLoaded('Alice', 'Rename contact');
  const dialog = await screen.findByRole('dialog');
  const form = dialog.querySelector('form') as HTMLFormElement;
  const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  // A browser submits a form on Enter through its submit button, which has to belong to that form. The Save
  // button sits in the dialog's footer, outside the form element.
  assert.ok(save.type === 'submit' && save.form === form, 'Enter in a name field has no submit button to press');

  fireEvent.change(within(dialog).getByLabelText('First name'), { target: { value: 'Alicia' } });
  fireEvent.click(save);
  await waitFor(() =>
    assert.deepEqual(
      fetchCalls.filter(c => c.method === 'PUT' && c.path.includes('/contacts/')).map(c => c.body),
      [{ firstName: 'Alicia' }],
      'a click on Save did not send the name exactly once',
    ),
  );
});

// ── The address book is read when a surface needs it, not when the page opens. ──

const contactReads = () =>
  fetchCalls.filter(c => c.method === 'GET' && c.path.startsWith(`/api/sessions/${SESSION.id}/contacts?`));

test('opening the page reads no address book', async () => {
  const { screen } = rtl;
  renderPage();
  await screen.findByText('Alice');
  await settle();
  assert.equal(contactReads().length, 0, 'the page walked the address book on mount');
});

test('the first menu to open reads the address book once, and its Save entry then follows it', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Rename contact' });
  assert.equal(contactReads().length, 1);

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await settle();
  assert.equal(contactReads().length, 1, 'a second menu read the address book again');
});

test("a group's menu has no use for the address book and does not read it", async () => {
  const { screen, fireEvent } = rtl;
  listGroup = true;
  renderPage();
  await screen.findByText('Team');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Team' }));
  await screen.findByRole('button', { name: 'Group info' });
  await settle();
  assert.equal(contactReads().length, 0, "a group's menu read the address book");
});

test("the room's menu asks for the address book as well", async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  assert.equal(contactReads().length, 0);
  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  await screen.findByRole('button', { name: 'Rename contact' });
  assert.equal(contactReads().length, 1);
});

test('the Unknown filter waits for the address book instead of listing nothing', async () => {
  const { screen, fireEvent } = rtl;
  listExtra = true;
  const release = hold('contacts');
  renderPage();
  await screen.findByText('Bobby');
  assert.equal(contactReads().length, 0);

  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
  assert.ok(screen.getByText('Loading chats...'), 'the filter did not wait for the address book');
  assert.ok(!screen.queryByText('No chats match this filter'), 'the filter claimed no chat matches');
  release();
  await screen.findByText('Bobby');
  assert.ok(!screen.queryByText('Alice'), 'a saved contact is listed as unknown');
});

test('the address book is not read again when the window regains focus, unless the last read failed', async () => {
  const { screen, fireEvent, act, waitFor } = rtl;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await screen.findByRole('button', { name: 'Rename contact' });
  const regainFocus = () =>
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

  // Stale, as it is five minutes on, yet not worth another walk of every contact.
  await queryClients[0].invalidateQueries({ queryKey: ['contacts', SESSION.id], refetchType: 'none' });
  regainFocus();
  await settle();
  assert.equal(contactReads().length, 1, 'focus walked the address book again');

  // A read that failed is tried again on the next focus.
  rtl.cleanup();
  failContacts = true;
  renderPage();
  await screen.findByText('Alice');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Alice' }));
  await waitFor(() => assert.equal(contactReads().length, 2));
  failContacts = false;
  regainFocus();
  await screen.findByRole('button', { name: 'Rename contact' });
  assert.equal(contactReads().length, 3);
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

// ── Baileys acknowledges the messages a read names, so the page names them. ──

const readBodies = (chatId: string) => readsOf(chatId).map(c => c.body);

test('on Baileys the automatic read names the incoming messages of the thread, newest included', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  aliceThread = [threadRow(1), threadRow(2, 'outgoing'), threadRow(3), threadRow(4)];
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(readsOf(CHAT.id).length >= 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });
  await screen.findByText('message 4');
  await waitFor(() => assert.ok(readBodies(CHAT.id).at(-1) !== undefined), { timeout: 3_000 });
  assert.deepEqual(readBodies(CHAT.id).at(-1), {
    chatId: CHAT.id,
    messageIds: ['wamid.in.1', 'wamid.in.3', 'wamid.in.4'],
  });
});

test('a message that arrives later is the only one the next read names', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  aliceThread = [threadRow(1), threadRow(2)];
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await screen.findByText('message 2');
  await waitFor(
    () => assert.deepEqual(readBodies(CHAT.id).at(-1), { chatId: CHAT.id, messageIds: ['wamid.in.1', 'wamid.in.2'] }),
    {
      timeout: 3_000,
    },
  );
  fetchCalls.length = 0;

  receiveFromAlice('wamid.live.1', 'a live one');
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1), { timeout: 3_000 });
  assert.deepEqual(readBodies(CHAT.id), [{ chatId: CHAT.id, messageIds: ['wamid.live.1'] }]);
});

test('a thread that loads after the opening read is read again with its ids', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  aliceThread = [threadRow(1), threadRow(2)];
  const release = hold('thread');
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  // The opening read is due before the thread has come, so it names nothing.
  await waitFor(() => assert.deepEqual(readBodies(CHAT.id), [{ chatId: CHAT.id }]), { timeout: 3_000 });

  release();
  await screen.findByText('message 2');
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 2), { timeout: 3_000 });
  assert.deepEqual(readBodies(CHAT.id).at(-1), { chatId: CHAT.id, messageIds: ['wamid.in.1', 'wamid.in.2'] });
});

test('on whatsapp-web.js the read names no message, since the engine reads the whole chat', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  aliceThread = [threadRow(1), threadRow(2)];
  renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await screen.findByText('message 2');
  await waitFor(() => assert.ok(readsOf(CHAT.id).length >= 1), { timeout: 3_000 });
  assert.deepEqual(readBodies(CHAT.id), [{ chatId: CHAT.id }]);
});

/** Make the document read as hidden (a background tab) or visible again, as the browser does before `visibilitychange`. */
function setTabHidden(hidden: boolean): void {
  if (hidden) {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    delete (document as unknown as Record<string, unknown>).hidden;
  }
}

/** A message from Alice, delivered the way the gateway's socket delivers one. */
function receiveFromAlice(id: string, body: string): void {
  rtl.act(() =>
    lastSocket()?.receive('message', {
      type: 'event',
      timestamp: new Date(1_700_002_000_000).toISOString(),
      payload: {
        event: 'message.received',
        sessionId: SESSION.id,
        data: {
          id,
          chatId: CHAT.id,
          from: CHAT.id,
          to: 'me',
          body,
          type: 'text',
          fromMe: false,
          timestamp: 1_700_001_900,
        },
      },
    }),
  );
}

test('a message that reaches the open chat while the tab is hidden is marked read once the tab is visible', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'opening the chat did not mark it read'), {
    timeout: 3_000,
  });
  fetchCalls.length = 0;

  setTabHidden(true);
  try {
    receiveFromAlice('wamid.hidden.1', 'are you there?');
    await screen.findAllByText('are you there?');
    // Past the quiet window the read would have gone out.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.deepEqual(readsOf(CHAT.id), [], 'a hidden tab sent a read receipt');
  } finally {
    setTabHidden(false);
  }
  rtl.act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1, 'the withheld read did not follow'), { timeout: 3_000 });
  assert.ok(!screen.queryByLabelText(/unread message/), 'the open chat was badged');
});

test('a tab that was hidden but sees no message owes no read when it is visible again', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.equal(readsOf(CHAT.id).length, 1), { timeout: 3_000 });
  fetchCalls.length = 0;

  setTabHidden(true);
  setTabHidden(false);
  rtl.act(() => {
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.deepEqual(readsOf(CHAT.id), []);
});

test("the open room's menu offers Mark as unread for a chat that was opened with unread messages", async () => {
  const { screen, fireEvent, waitFor, within } = rtl;
  aliceNow.unreadCount = 2;
  const { container } = renderPage();
  await screen.findByLabelText('2 unread messages');
  fireEvent.click(screen.getByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));
  await waitFor(() => assert.ok(!screen.queryByLabelText('2 unread messages'), 'opening the chat kept its badge'));

  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  const menu = container.querySelector('.room-menu-popover') as HTMLElement;
  assert.ok(within(menu).getByRole('button', { name: 'Mark as unread' }), 'the room menu lacks Mark as unread');
});

test("the open room's menu follows the chat list when a reload brings a change made elsewhere", async () => {
  const { screen, fireEvent, act, waitFor, within } = rtl;
  const { container } = renderPage();
  fireEvent.click(await screen.findByText('Alice'));
  await waitFor(() => assert.ok(container.querySelector('.room-header'), 'the room did not open'));

  // The phone pins the chat, and a reconnect reloads the list.
  aliceNow.pinned = true;
  const socket = lastSocket();
  assert.ok(socket, 'the page opened no socket');
  act(() => socket.receive('disconnect', 'transport close'));
  act(() => socket.receive('connect'));
  await screen.findByRole('img', { name: 'Pinned' });

  fireEvent.click(container.querySelector('.room-menu-trigger') as HTMLElement);
  const menu = container.querySelector('.room-menu-popover') as HTMLElement;
  assert.ok(within(menu).getByRole('button', { name: 'Unpin chat' }), 'the room menu kept offering Pin chat');
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
