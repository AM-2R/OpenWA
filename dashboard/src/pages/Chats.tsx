import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { nextReconnectState } from '../utils/reconnectState';
import { applyIncomingToChatList, promoteChatWithSnippet } from '../utils/chatList';
import {
  applyChatListFilter,
  contactKey,
  filterChats,
  filterChannels,
  groupStatusesByContact,
  phoneContactId,
  savedContactKeySet,
  type ChatListFilter,
} from '../utils/chatFilters';
import {
  ArrowLeft,
  Loader2,
  Megaphone,
  CircleDashed,
  AlertCircle,
  MessageSquare,
  CircleEllipsis,
  Copy,
  X,
} from 'lucide-react';
import { useProfilePicture } from '../hooks/useProfilePicture';
import { useProfilePictures } from '../hooks/useProfilePictures';
import { useResolvedPhone } from '../hooks/useResolvedPhone';
import { formatPhoneForDisplay } from '../utils/formatPhone';
import {
  sessionApi,
  messageApi,
  contactApi,
  asMessageType,
  type Session,
  type Chat,
  type ChatKind,
  type Channel,
  type SearchHit,
  type ContactStatusGroup,
} from '../services/api';
import {
  applyMessageEdit,
  mergeDeliveryStatus,
  mergeReactionSnapshot,
  findRevokedIndex,
  patchMatchingMessage,
  byMessageId,
  getMediaSrc,
  liveMessageMetadata,
  stripMentionDelimiters,
  type ChatMessageView,
  type MessageMedia,
} from '../utils/chatMessages';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import { GlobalSearch } from '../components/GlobalSearch';
import {
  useChatMessages,
  useChatMessagesActions,
  messagesQueryKey,
  updateCachedMessages,
  cachedSessionThreads,
} from '../hooks/useChatMessages';
import { useChannelMessages } from '../hooks/useChannelMessages';
import { useContactStatuses } from '../hooks/useContactStatuses';
import { useChatScrollPosition } from '../hooks/useChatScrollPosition';
import { createTrailingCoalescer } from '../utils/trailingCoalescer';
import MessageBody from '../components/chats/MessageBody';
import MediaLightbox, { type LightboxItem } from '../components/chats/MediaLightbox';
import KindIcon from '../components/chats/KindIcon';
import ChatSidebar from '../components/chats/ChatSidebar';
import ChatThread from '../components/chats/ChatThread';
import ChatComposer, { type StagedAttachment } from '../components/chats/ChatComposer';
import StatusMedia from '../components/chats/StatusMedia';
import StatusComposeModal from '../components/chats/StatusComposeModal';
import NewChatPanel from '../components/chats/NewChatPanel';
import GroupInfoDialog from '../components/chats/GroupInfoDialog';
import { MuteChatDialog, SaveContactDialog, type MuteDuration } from '../components/chats/ChatDialogs';
import type { ChatRowActions } from '../components/chats/chatActionItems';
import { ChatActions } from '../components/chats/ChatRowMenu';
import { Modal } from '../components/Modal';
import './Chats.css';

// Quiet window for coalescing mark-as-read RPCs (see markReadCoalescer below).
const MARK_READ_DEBOUNCE_MS = 750;
const readKey = (sessionId: string, chatId: string) => `${sessionId}\u0000${chatId}`;

// mergeDeliveryStatus (forward-only delivery-tick merge) is shared with mergeOrAppend in utils/chatMessages
// so the WS append path and the ack path apply the exact same rule.

interface IncomingWsMessage {
  id: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe?: boolean;
  media?: MessageMedia;
  quotedMessage?: { id: string; body: string };
  // The backend emits `call` as a top-level field on the live `message.received` event (it's only
  // folded into `metadata` on the persisted/history path), so declare it here to carry it through.
  call?: { video: boolean; missed: boolean };
  /** Business prompt choices (Baileys); top-level on the live event, folded into metadata for the UI. */
  buttons?: Array<{ id: string; text: string }>;
  poll?: { name: string; options: string[]; allowMultipleAnswers: boolean };
  metadata?: ChatMessageView['metadata'];
  kind?: ChatKind;
  /** Group poster: `from` is the group JID, so `contact`/`author` identify who actually sent it. */
  contact?: { id?: string; name?: string; pushName?: string };
  author?: string;
}

// WhatsApp's text-status font slots — the current wire enum is {0,1,2,6,7,8,9,10} (6 is the bold
// system face); 3–5 are legacy slots older clients still emit. Approximated with generic
// families/weights since the actual faces are proprietary; slot 0 and unknown slots keep the UI
// default.
// The confirmation dialog's copy for each destructive chat row action; its confirm button repeats the title.
const CONFIRM_TEXT = {
  leave: {
    title: 'chats.group.leave',
    question: 'chats.group.leaveConfirm',
    warning: 'chats.group.leaveWarning',
  },
  clear: {
    title: 'chats.rowActions.clear',
    question: 'chats.rowActions.clearConfirm',
    warning: 'chats.rowActions.clearWarning',
  },
  block: {
    title: 'chats.rowActions.block',
    question: 'chats.rowActions.blockConfirm',
    warning: 'chats.rowActions.blockWarning',
  },
  delete: {
    title: 'chats.rowActions.delete',
    question: 'chats.rowActions.deleteConfirm',
    warning: 'chats.rowActions.deleteWarning',
  },
} as const;

const STATUS_FONT: Record<number, { family?: string; weight?: number }> = {
  1: { family: 'serif' },
  2: { family: 'cursive' },
  3: { family: 'fantasy' }, // legacy
  4: { family: 'serif' }, // legacy
  5: { family: 'ui-rounded, system-ui, sans-serif' }, // legacy
  6: { weight: 700 },
  7: { family: 'cursive' },
  8: { family: 'serif' },
  9: { family: 'sans-serif', weight: 800 },
  10: { family: 'monospace', weight: 700 },
};

/** Inline style for a status item's font slot; {} when unstyled/unknown. */
const statusFontStyle = (font?: number): { fontFamily?: string; fontWeight?: number } => {
  if (font === undefined) return {};
  const slot = STATUS_FONT[font];
  if (!slot) return {};
  return {
    ...(slot.family ? { fontFamily: slot.family } : {}),
    ...(slot.weight ? { fontWeight: slot.weight } : {}),
  };
};

export function Chats() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.chats'));
  const { error: showErrorToast, warning: showWarningToast, success: showSuccessToast } = useToast();
  const { canWrite, engineType } = useRole();

  // Sessions list & active session
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [loadingSessions, setLoadingSessions] = useState<boolean>(true);

  // Chats list
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadingChats, setLoadingChats] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [chatFilter, setChatFilter] = useState<ChatListFilter>('all');

  // The new-chat panel replaces the sidebar lists while open; the room's overflow menu drops from its header.
  const [showNewChat, setShowNewChat] = useState<boolean>(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState<boolean>(false);
  const roomMenuRef = useRef<HTMLDivElement | null>(null);
  // The group whose info dialog is open, from its row's menu or from the open room's.
  const [groupDialogChat, setGroupDialogChat] = useState<Chat | null>(null);
  // A destructive row action awaiting confirmation, and whether it is in flight.
  const [confirmAction, setConfirmAction] = useState<{
    kind: 'leave' | 'clear' | 'delete' | 'block';
    chat: Chat;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState<boolean>(false);
  // The archive view of the Chats tab, and the chats whose mute or contact dialog is open.
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [muteDialogChat, setMuteDialogChat] = useState<Chat | null>(null);
  const [contactDialogChat, setContactDialogChat] = useState<Chat | null>(null);
  const [dialogBusy, setDialogBusy] = useState<boolean>(false);

  // Selected chat & message history
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  // Only the contact id is state — the open group is derived from groupedStatuses at render, so a
  // refetch (window focus, post-compose) flows straight into the open viewer instead of leaving it
  // pinned to the snapshot captured at click time. A group that disappears (all items expired)
  // simply closes the viewer.
  const [activeStatusContactId, setActiveStatusContactId] = useState<string | null>(null);

  // Chats/Channels/Status tab selection. Switching tabs closes whatever conversation is open so a
  // press on another tab doesn't leave a Chats-tab room rendered underneath a Channels/Status list.
  const [activeTab, setActiveTab] = useState<'chats' | 'channels' | 'status'>('chats');
  const switchTab = useCallback((tab: 'chats' | 'channels' | 'status') => {
    setActiveTab(tab);
    setActiveChat(null);
    setActiveChannel(null);
    setActiveStatusContactId(null);
  }, []);

  // Channels tab: only whatsapp-web.js implements channel listing/reading — Baileys throws 501 for
  // both, so the query is gated off entirely (never fired) rather than left to fail per-request.
  // The engine comes from the sign-in validate response, which every role can read.
  const channelsSupported = engineType === 'whatsapp-web.js';
  // On Baileys the phone can ignore a clear or delete the gateway reports as done, and the gateway then drops
  // its stored copy of the messages (#1891). Until that is fixed both are offered on whatsapp-web.js only.
  const canClearOrDelete = canWrite && engineType === 'whatsapp-web.js';
  const channelsQuery = useQuery({
    queryKey: ['channels', selectedSessionId],
    queryFn: () => sessionApi.getSubscribedChannels(selectedSessionId!),
    enabled: Boolean(selectedSessionId) && channelsSupported && activeTab === 'channels',
  });
  const channelMessages = useChannelMessages(selectedSessionId, activeChannel?.id ?? null);

  // Status tab: both engines expose stored status content, so this query isn't engine-gated (unlike
  // channelsQuery above) — but it is tab-gated the same way, so selecting a session on another tab
  // doesn't fire a background /status fetch nobody is looking at.
  const statusesQuery = useContactStatuses(selectedSessionId, activeTab === 'status');

  // A channel feed opens at its newest post, mirroring the chat room's initial scroll. The pane is
  // also keyed by channel id, so switching channels remounts the feed instead of reusing the DOM
  // (and its stale scroll offset) of the previous channel.
  const channelFeedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = channelFeedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeChannel?.id, channelMessages.data]);

  // --- Status compose modal ---
  // The page owns only the open flag (its trigger sits in the sidebar header below); the form
  // itself — state, contacts query, submit — is components/chats/StatusComposeModal.
  const [composeOpen, setComposeOpen] = useState<boolean>(false);

  const {
    data: messages = [],
    isLoading: loadingMessages,
    isError: messagesError,
    hasNextPage: hasMoreMessages,
    isFetchingNextPage: loadingOlderMessages,
    fetchNextPage,
  } = useChatMessages(selectedSessionId, activeChat?.id ?? null);
  const { appendMessage, updateMessage } = useChatMessagesActions();
  const queryClient = useQueryClient();

  // Lightbox state for media viewer
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  // Draft text lives here (not in ChatComposer) so it survives closing/switching the room.
  const [messageInput, setMessageInput] = useState<string>('');
  // The staged attachment lives here for the same reason the draft text does — ChatComposer
  // unmounts when the room closes, which would silently discard a picked file. Unlike the text
  // draft it is dropped when a DIFFERENT chat is opened (see the effect below): a file that
  // follows the user into another conversation can be sent to the wrong recipient.
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Revoke the object URL created for an image-attachment preview once it is replaced or cleared.
  // The cleanup runs with the previous value on every change, so this single effect covers all
  // paths (new file, remove, send, chat switch) — otherwise each preview leaks a blob held for the
  // lifetime of the document. It lives here, not in ChatComposer: revoking on the composer's
  // unmount would hand a reopened room a dead blob URL for an attachment that is still staged.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // Drop a staged attachment and a staged reply when the user moves to a DIFFERENT chat. Closing the
  // room (`activeChat` → null) deliberately keeps them, so close/reopen is a lossless round trip; only
  // an actual change of conversation clears. A reply carried across would quote the previous chat's
  // message, text and sender included, into the new one. The composer invalidates its in-flight
  // FileReader on the same transition, so a late read cannot re-stage the file against the new chat.
  const lastRoomIdRef = useRef<string | null>(null);
  useEffect(() => {
    const current = activeChat?.id ?? null;
    if (current === null) return;
    const previous = lastRoomIdRef.current;
    lastRoomIdRef.current = current;
    if (previous === null || previous === current) return;
    setAttachment(null);
    setPreviewUrl(null);
    setReplyingTo(null);
  }, [activeChat]);

  // Per-chat scroll-position memory + auto-scroll heuristic.
  // Pass `messages.length > 0` as the loaded signal: it stays stable once the
  // chat has any message (doesn't toggle per append) and covers both the
  // first-fetch resolution and a WS-driven first message on a previously-empty
  // chat. `loadingMessages` alone would miss the latter case.
  const {
    containerRef: messagesContainerRef,
    onMessageAppended,
    onMediaLoad,
    measureMedia,
    onOlderMessagesRequested,
  } = useChatScrollPosition(activeChat?.id ?? null, messages.length > 0, loadingOlderMessages);

  const handleLoadOlderMessages = useCallback(() => {
    onOlderMessagesRequested();
    void fetchNextPage();
  }, [fetchNextPage, onOlderMessagesRequested]);

  // Batch profile-picture fetch for the visible chat list — ONE request for the whole sidebar
  // (per-row queries burst the per-IP throttle into 429s). Sorted-key cached 1h; rows fall back
  // to the generic icon for ids that resolve null.
  const chatIds = useMemo(() => chats.map(c => c.id), [chats]);
  const listPics = useProfilePictures(selectedSessionId || undefined, chatIds);

  // Profile-picture fetch for the active room (cached 1h by useProfilePicture; TanStack Query
  // dedupes, so other components querying the same key share this slice).
  const activePp = useProfilePicture(selectedSessionId || undefined, activeChat?.id);

  // Header phone line. Local formatting handles @c.us ids offline; for anything else personal
  // (notably @lid privacy ids, which are NOT phones and must never be formatted as one) resolve
  // the real number through the engine — cached a day, and only fired when local formatting failed.
  const activePhoneDisplay = activeChat ? formatPhoneForDisplay(activeChat.id) : null;
  const needsPhoneResolution = Boolean(activeChat && activeChat.kind === 'individual' && !activePhoneDisplay);
  const resolvedPhoneQ = useResolvedPhone(
    needsPhoneResolution ? selectedSessionId || undefined : undefined,
    needsPhoneResolution ? activeChat?.id : undefined,
  );
  const activePhoneText =
    activePhoneDisplay ?? (resolvedPhoneQ.data ? formatPhoneForDisplay(resolvedPhoneQ.data) : null);

  // The list loaders below reach the translator and the error toast through a ref, not as
  // dependencies: both change identity on a language switch, which re-ran the session load (it
  // reselected the first session) and, through loadChats, the session-reset effect (it closed the
  // open chat and dropped a staged file or reply).
  const loadErrorRef = useRef({ t, showErrorToast });
  useEffect(() => {
    loadErrorRef.current = { t, showErrorToast };
  });
  const showLoadError = useCallback((key: string, err: unknown) => {
    const current = loadErrorRef.current;
    current.showErrorToast(current.t(key), err instanceof Error ? err.message : undefined);
  }, []);

  // 1. Fetch available connected sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      try {
        setLoadingSessions(true);
        const list = await sessionApi.list();
        const readySessions = list.filter(s => s.status === 'ready');
        setSessions(readySessions);
        if (readySessions.length > 0) {
          setSelectedSessionId(readySessions[0].id);
        }
      } catch (err) {
        showLoadError('chats.errors.loadSessions', err);
      } finally {
        setLoadingSessions(false);
      }
    };
    void loadSessions();
  }, [showLoadError]);

  // 2. Fetch chats when active session changes. A session switch does not cancel the list still
  // loading for the session left behind, so an answer for any session but the latest call's is
  // dropped, or it would put that account's chats under the selected session. Within one session an
  // answer is dropped only once a newer one has landed: dropping every answer a newer call overtook
  // left a burst of realtime refetches with no list at all, each miss firing the next refetch.
  // A realtime refetch runs in the background, keeping the current list on screen.
  const chatsLoadsRef = useRef(new Set<AbortController>());
  const chatsRequestRef = useRef(0);
  const chatsAppliedRef = useRef(0);
  const chatsSessionRef = useRef('');
  // The session whose list `chats` holds, which a switch leaves on screen until the new list lands.
  const listedSessionRef = useRef('');
  // The newest request number out when a live frame last moved each chat's row. A send stamps its row
  // with the browser clock, so only this, not a newer timestamp, shows a row changed after a refetch left.
  const liveRowsRef = useRef(new Map<string, number>());
  const loadChats = useCallback(
    async (sessionId: string, { background = false } = {}): Promise<boolean> => {
      if (!sessionId) return false;
      const controller = new AbortController();
      chatsLoadsRef.current.add(controller);
      const request = ++chatsRequestRef.current;
      chatsSessionRef.current = sessionId;
      const stale = () =>
        controller.signal.aborted || sessionId !== chatsSessionRef.current || request < chatsAppliedRef.current;
      // A stale answer for the session still selected was overtaken by a newer list that has applied,
      // so this session's list on screen is as fresh as this call's would have been.
      const overtaken = () => !controller.signal.aborted && sessionId === chatsSessionRef.current;
      try {
        if (!background) setLoadingChats(true);
        const data = await sessionApi.getChats(sessionId, controller.signal);
        if (stale()) return overtaken();
        chatsAppliedRef.current = request;
        // A live frame can move a row past the snapshot a background refetch was built from while it is
        // out. That row is kept, or its preview and unread badge would roll back until the next message.
        const moved = (id: string) => (liveRowsRef.current.get(id) ?? 0) >= request;
        const merge = background && listedSessionRef.current === sessionId;
        listedSessionRef.current = sessionId;
        setChats(prev => {
          const live = new Map(merge ? prev.map(c => [c.id, c] as const) : []);
          const fetchedIds = new Set(data.map(c => c.id));
          const rows = [...data, ...prev.filter(c => merge && moved(c.id) && !fetchedIds.has(c.id))];
          return rows
            .map(c => {
              const row = live.get(c.id);
              return row && moved(c.id) && (row.timestamp || 0) > (c.timestamp || 0) ? row : c;
            })
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        });
        return true;
      } catch (err) {
        if (stale()) return overtaken();
        // A background refetch only refreshes summaries: keep the list it would have replaced.
        if (background) return false;
        showLoadError('chats.errors.loadChats', err);
        listedSessionRef.current = sessionId;
        setChats([]);
        return false;
      } finally {
        chatsLoadsRef.current.delete(controller);
        // Only the call that raised the spinner clears it: a background refetch settling first would
        // otherwise uncover the previous session's list while the switch's own load is still out.
        if (!background && !controller.signal.aborted && sessionId === chatsSessionRef.current) setLoadingChats(false);
      }
    },
    [showLoadError],
  );

  // A send resolves after the await, possibly once another session's list is on screen. That list can
  // hold a chat with the same id (a group or contact both accounts share), so the promote only applies
  // to the session the send started in.
  const promoteSentChat = useCallback((sessionId: string, chatId: string, snippet: string, sentAt: number) => {
    if (sessionId !== chatsSessionRef.current) return;
    setChats(prev => promoteChatWithSnippet(prev, chatId, snippet, sentAt));
  }, []);

  useEffect(() => {
    const loads = chatsLoadsRef.current;
    if (selectedSessionId) {
      void loadChats(selectedSessionId);
      setActiveChat(null);
      setActiveChannel(null);
      setActiveStatusContactId(null);
      // A staged attachment or reply belongs to a chat in the session being left, so it is dropped here
      // rather than carried across — the close/reopen round trip that preserves it is scoped to a
      // single session. Clearing previewUrl runs the revoke effect's cleanup; the composer
      // unmounts with the closed room and invalidates its own in-flight FileReader.
      setAttachment(null);
      setPreviewUrl(null);
      setReplyingTo(null);
      lastRoomIdRef.current = null;
      // The new-chat panel lists the address book of the session being left, and an open dialog acts
      // through it.
      setShowNewChat(false);
      setGroupDialogChat(null);
      setConfirmAction(null);
      setMuteDialogChat(null);
      setContactDialogChat(null);
      setShowArchived(false);
    }
    return () => {
      for (const controller of loads) controller.abort();
      loads.clear();
    };
  }, [selectedSessionId, loadChats]);

  // Coalesce mark-as-read RPCs per chat: every incoming message in the visible chat raises a
  // read event, and a per-event POST sprays the gateway into 429s. One trailing call per chat
  // after a quiet window carries the same effect.
  // A chat marked unread takes no automatic read until it is opened again, and Mark as unread waits for a
  // read already sent: otherwise a read queued from the open room lands after the unread and undoes it.
  // Keyed by session and chat, since a session switch still flushes the previous session's reads.
  const [readsInFlight] = useState(() => new Map<string, Promise<void>>());
  const [keptUnread] = useState(() => new Set<string>());
  const markReadCoalescer = useMemo(
    () =>
      createTrailingCoalescer<string>(chatId => {
        const key = readKey(selectedSessionId, chatId);
        const read = sessionApi.markChatRead(selectedSessionId, chatId).then(
          () => undefined,
          err => {
            showWarningToast(t('chats.errors.markRead'), err instanceof Error ? err.message : undefined);
          },
        );
        readsInFlight.set(key, read);
        void read.finally(() => {
          if (readsInFlight.get(key) === read) readsInFlight.delete(key);
        });
      }, MARK_READ_DEBOUNCE_MS),
    [selectedSessionId, t, showWarningToast, readsInFlight],
  );

  // Flush pending trailing calls on unmount / session switch: the mark-as-read POST is
  // fire-and-forget (a failure only raises a warning toast), so firing on the way out is safe —
  // and dropping the pending call would leave the last messages of a quickly-exited chat unread.
  // The flush closure still references the PREVIOUS session on a session switch, which is exactly
  // where those queued reads belong. Logout removes the key before the page unmounts, though: a
  // read flushed then goes out keyless and its 401 reloads the login form, so drop it instead.
  useEffect(
    () => () => {
      if (sessionStorage.getItem('openwa_api_key')) markReadCoalescer.flush();
      else markReadCoalescer.cancel();
    },
    [markReadCoalescer],
  );

  // Marking a chat read is an operator write; a read-only key would only collect 403 toasts.
  // A session switch rebuilds the coalescer for the new session one render before the open chat is
  // cleared, so until the new session's list is on screen the open chat is still the previous
  // account's and nothing is marked read.
  const markChatRead = useCallback(
    (chatId: string) => {
      if (keptUnread.has(readKey(selectedSessionId, chatId))) return;
      if (canWrite && listedSessionRef.current === selectedSessionId) markReadCoalescer.call(chatId);
    },
    [markReadCoalescer, canWrite, selectedSessionId, keptUnread],
  );

  // 3. WebSocket integration for real-time messages
  // Synced in a layout effect: a socket frame handled after the list commits but before passive
  // effects flush would otherwise see the previous list, miss the chat and refetch the whole list.
  const chatsRef = useRef(chats);
  const activeChatIdRef = useRef<string | undefined>(undefined);
  // The session on screen, for requests that answer later to check they still belong to it.
  const selectedSessionRef = useRef(selectedSessionId);
  useLayoutEffect(() => {
    chatsRef.current = chats;
    activeChatIdRef.current = activeChat?.id;
    selectedSessionRef.current = selectedSessionId;
  });
  // A request that settles after the page is left no longer finds the chat open, so its follow-ups
  // (the reconnect mark-as-read) do nothing.
  useEffect(
    () => () => {
      activeChatIdRef.current = undefined;
    },
    [],
  );
  const handleIncomingMessage = useCallback(
    (event: { sessionId: string; message: Record<string, unknown> }) => {
      if (event.sessionId !== selectedSessionId) return;

      const newMsg = event.message as unknown as IncomingWsMessage;
      if (
        cachedSessionThreads(
          queryClient,
          event.sessionId,
          m => m.chatId === newMsg.chatId && byMessageId(newMsg.id)(m) && m.type === 'revoked',
        ).length
      ) {
        return;
      }

      const mappedMessage: ChatMessageView = {
        id: newMsg.id,
        waMessageId: newMsg.id,
        chatId: newMsg.chatId,
        // For a group post `from` is the group JID, so the sender's name is carried on `contact`.
        // Persisted rows keep the same value in `chatName`; normalize both to one field for the thread.
        chatName: newMsg.contact?.pushName ?? newMsg.contact?.name,
        author: newMsg.author,
        from: newMsg.from,
        to: newMsg.to,
        body: newMsg.body,
        type: asMessageType(newMsg.type),
        direction: newMsg.fromMe ? 'outgoing' : 'incoming',
        status: 'sent',
        timestamp: newMsg.timestamp,
        createdAt: new Date(newMsg.timestamp * 1000).toISOString(),
        metadata: liveMessageMetadata(newMsg),
        kind: newMsg.kind,
      };

      // Always write to the React Query cache for this message's session — keeps non-active chats
      // up to date so re-opening them shows fresh data without a refetch.
      appendMessage(event.sessionId, newMsg.chatId, mappedMessage);

      // If the message belongs to the currently visible chat, mark-as-read and run the scroll heuristic.
      if (activeChat && newMsg.chatId === activeChat.id) {
        markChatRead(activeChat.id);
        if (!newMsg.fromMe) onMessageAppended('incoming');
      }

      // Update sidebar chat list. Whether the chat is missing is decided against the list on screen,
      // never inside the updater: React double-invokes updaters under StrictMode, and it may defer
      // one to the next render, so a flag set in there was still false when read here and a chat the
      // sidebar does not list never appeared.
      const listOptions = {
        // Only a chat this key marks read is exempt from the unread count (see markChatRead).
        activeChatId: canWrite ? activeChat?.id : undefined,
        // A location message's body is the (multi-KB) base64 map thumbnail; show a label instead.
        locationLabel: `📍 ${t('chats.media.location')}`,
      };
      liveRowsRef.current.set(newMsg.chatId, chatsRequestRef.current);
      const { needsSidebarRefetch } = applyIncomingToChatList(chatsRef.current, newMsg, listOptions);
      setChats(prevChats => applyIncomingToChatList(prevChats, newMsg, listOptions).chats);
      if (needsSidebarRefetch) {
        void loadChats(selectedSessionId, { background: true });
      }
    },
    [
      selectedSessionId,
      activeChat,
      canWrite,
      loadChats,
      markChatRead,
      appendMessage,
      onMessageAppended,
      queryClient,
      t,
    ],
  );

  const handleIncomingMessageAck = useCallback(
    (event: { sessionId: string; messageId: string; status: ChatMessageView['status'] }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Acks can arrive for any cached chat under this session, so every thread is checked.
      for (const [key, thread] of cachedSessionThreads(queryClient, event.sessionId, byMessageId(event.messageId))) {
        const target = thread.find(byMessageId(event.messageId));
        if (!target) continue;
        // Backend now sends the neutral delivery status directly (no engine-specific ack codes).
        // Merge forward-only so an out-of-order/replayed lower ack can't downgrade the tick.
        const nextStatus = mergeDeliveryStatus(target.status, event.status) ?? target.status;
        if (nextStatus === target.status) continue;
        updateCachedMessages(queryClient, key, list =>
          patchMatchingMessage(list, event.messageId, m => ({ ...m, status: nextStatus })),
        );
      }
    },
    [selectedSessionId, queryClient],
  );

  const handleIncomingMessageReaction = useCallback(
    (event: { sessionId: string; messageId: string; reactions?: Record<string, string> }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Reactions update `metadata.reactions` while preserving `metadata.media` / `metadata.quotedMessage`,
      // so we must read the prior message and deep-merge — `updateMessage`'s shallow merge would clobber
      // the rest of metadata.
      //
      // The absent-vs-empty distinction on `reactions` is mergeReactionSnapshot's job; it is a named
      // function so the behaviour is covered by a test, because nothing here is.
      for (const [key] of cachedSessionThreads(queryClient, event.sessionId, byMessageId(event.messageId))) {
        updateCachedMessages(queryClient, key, list =>
          patchMatchingMessage(list, event.messageId, m =>
            m.type === 'revoked'
              ? m
              : {
                  ...m,
                  metadata: {
                    ...(m.metadata || {}),
                    reactions: mergeReactionSnapshot(m.metadata?.reactions, event.reactions),
                  },
                },
          ),
        );
      }
    },
    [selectedSessionId, queryClient],
  );

  const handleIncomingMessageRevoked = useCallback(
    (event: { sessionId: string; id: string; revokedId?: string; chatId: string; type: string }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Walk every cached chat under this session, find the deleted message and zero it — the
      // backend emits an empty body; the localized "deleted" label is rendered below. Matching is
      // in findRevokedIndex: the event carries two candidate ids and wwebjs's `id` alone can miss.
      const revoked = (m: ChatMessageView): boolean => findRevokedIndex([m], event) !== -1;
      let matchedCachedMessage = false;
      let revokedLastMessage = false;
      for (const [key, thread] of cachedSessionThreads(queryClient, event.sessionId, revoked)) {
        matchedCachedMessage = true;
        // The sidebar previews the newest row, so only deleting that one changes it.
        if (key[2] === event.chatId && findRevokedIndex(thread, event) === thread.length - 1) {
          revokedLastMessage = true;
        }
        updateCachedMessages(queryClient, key, list => {
          const idx = findRevokedIndex(list, event);
          if (idx === -1) return list;
          const next = list.slice();
          next[idx] = { ...next[idx], body: '', type: asMessageType(event.type), metadata: undefined };
          return next;
        });
      }
      if (revokedLastMessage) {
        setChats(previous =>
          previous.map(chat =>
            chat.id === event.chatId ? { ...chat, lastMessage: '', lastMessageType: 'revoked' } : chat,
          ),
        );
      } else if (!matchedCachedMessage) {
        // No cached thread proves whether the deleted message was the chat's newest; refresh the
        // summaries, as an edit does.
        void loadChats(selectedSessionId, { background: true });
      }
    },
    [selectedSessionId, queryClient, loadChats],
  );

  const handleIncomingMessageEdited = useCallback(
    (event: { sessionId: string; messageId: string; chatId: string; body: string }) => {
      if (event.sessionId !== selectedSessionId) return;

      let matchedCachedMessage = false;
      let editedLastMessage = false;
      for (const [key, thread] of cachedSessionThreads(queryClient, event.sessionId, byMessageId(event.messageId))) {
        // Position is asked of the merged thread, never of a page: pages carry only a fraction of
        // the chat each, so "is this the last message" is only ever answerable from the whole thing.
        const editedIndex = thread.findIndex(byMessageId(event.messageId));
        if (editedIndex === -1 || thread[editedIndex].type === 'revoked') continue;
        matchedCachedMessage = true;
        updateCachedMessages(queryClient, key, list => applyMessageEdit(list, event));

        // Only editing the newest row changes the sidebar preview. Confirm the thread belongs to
        // the event chat before touching that summary.
        if (key[2] === event.chatId && editedIndex === thread.length - 1) editedLastMessage = true;
      }
      if (editedLastMessage) {
        setChats(previous =>
          previous.map(chat => (chat.id === event.chatId ? { ...chat, lastMessage: event.body } : chat)),
        );
      } else if (!matchedCachedMessage) {
        // The chat may never have been opened, so there is no message cache from which to prove
        // whether this was its latest row. Refresh summaries instead of guessing and overwriting the
        // sidebar with the body of an older edited message.
        void loadChats(selectedSessionId, { background: true });
      }
    },
    [selectedSessionId, queryClient, loadChats],
  );

  // A contact's new story lands here instead of in the message pipeline; invalidate the statuses
  // query so the Status tab refetches live. A disabled query (another tab active) just goes stale
  // and refetches on open — no background fetch either way.
  const handleStatusReceived = useCallback(
    (event: { sessionId: string }) => {
      queryClient.invalidateQueries({ queryKey: ['contact-statuses', event.sessionId] });
    },
    [queryClient],
  );

  // The events object must be referentially stable: useWebSocket re-registers its socket handler
  // on every identity change, so an inline literal would tear down and re-attach per render.
  const wsEvents = useMemo(
    () => ({
      onMessage: handleIncomingMessage,
      onMessageAck: handleIncomingMessageAck,
      onMessageReaction: handleIncomingMessageReaction,
      onMessageRevoked: handleIncomingMessageRevoked,
      onMessageEdited: handleIncomingMessageEdited,
      onStatusReceived: handleStatusReceived,
    }),
    [
      handleIncomingMessage,
      handleIncomingMessageAck,
      handleIncomingMessageReaction,
      handleIncomingMessageRevoked,
      handleIncomingMessageEdited,
      handleStatusReceived,
    ],
  );
  const { isConnected, connectionFailed, reconnect, subscribe, unsubscribe } = useWebSocket(wsEvents);

  // A transient WebSocket gap means message.received/ack/revoke/status events were missed. On a
  // reconnect (isConnected false→true after a prior connect), refresh what the gap left stale; the
  // threads are refreshed by the subscribe effect below, which runs on every connect. A failed feed
  // counts as a gap even if it never connected, so the banner's retry refreshes too. The transition
  // logic is unit-tested in utils/reconnectState.
  const reconnectHadConnected = useRef(false);
  const reconnectWasDisconnected = useRef(false);
  const activeChatId = activeChat?.id;
  useEffect(() => {
    const decision = nextReconnectState({
      isConnected,
      hadConnected: reconnectHadConnected.current,
      wasDisconnected: reconnectWasDisconnected.current,
      connectionFailed,
    });
    reconnectHadConnected.current = decision.hadConnected;
    reconnectWasDisconnected.current = decision.wasDisconnected;
    if (decision.invalidate) {
      // Statuses are live now (status.received): a story posted during the socket gap would
      // otherwise stay invisible until a focus refetch.
      queryClient.invalidateQueries({ queryKey: ['contact-statuses', selectedSessionId] });
      // The sidebar list is local state, so previews, unread counts and chats started during the gap
      // only show after a refetch. Background mode keeps the current list on screen meanwhile.
      // The open chat's gap messages are read on screen, so once the refetch has applied this session's
      // list and the chat is still open, mark it read and zero its row, since the snapshot still counts
      // them (the same rule a live frame and opening a chat follow). An applied list also means the engine
      // answers again: after a backend restart it may still be starting, and a read sent then fails. A
      // newer list for this session that overtook the refetch counts as applied. A refetch that failed
      // with no newer list applied, or a session switch, sends nothing; a chat the user left keeps its
      // count.
      const readChatId = canWrite ? activeChatId : undefined;
      void loadChats(selectedSessionId, { background: true }).then(applied => {
        if (!applied || !readChatId || activeChatIdRef.current !== readChatId) return;
        markChatRead(readChatId);
        setChats(prev => prev.map(c => (c.id === readChatId ? { ...c, unreadCount: 0 } : c)));
      });
    }
  }, [isConnected, connectionFailed, selectedSessionId, queryClient, loadChats, activeChatId, canWrite, markChatRead]);

  // The threads cache at staleTime: Infinity, and this session's events were not delivered while
  // another session was selected or the page was away. Mark them stale on a mount or a session switch
  // so the open one refetches and the others do when opened, with or without a live feed (a
  // chat-restricted key gets only its chats' message events).
  useEffect(() => {
    if (selectedSessionId) void queryClient.invalidateQueries({ queryKey: ['messages', selectedSessionId] });
  }, [selectedSessionId, queryClient]);

  useEffect(() => {
    if (selectedSessionId && isConnected) {
      subscribe(selectedSessionId, [
        'message.received',
        'message.sent',
        'message.ack',
        'message.reaction',
        'message.revoked',
        'message.edited',
        'status.received',
      ]);
      // Events sent while the socket was down were not delivered: after a reconnect, a cached thread
      // may miss some. Mark them stale the same way.
      void queryClient.invalidateQueries({ queryKey: ['messages', selectedSessionId] });
      return () => {
        unsubscribe(selectedSessionId);
      };
    }
  }, [selectedSessionId, isConnected, subscribe, unsubscribe, queryClient]);

  // 4. Message history is fetched by useChatMessages (React Query). The active-chat side effects
  // (mark-as-read + clear sidebar unread badge) live in a small effect below.

  const handleReactMessage = async (msg: ChatMessageView, emoji: string) => {
    if (!selectedSessionId || !activeChat) return;

    const msgId = msg.waMessageId || msg.id;
    const currentReactions = msg.metadata?.reactions || {};
    const sessionPhone = sessions.find(s => s.id === selectedSessionId)?.phone || 'me';

    let alreadyReacted = false;
    for (const [sender, emo] of Object.entries(currentReactions)) {
      if ((sender === 'me' || sender.includes(sessionPhone)) && emo === emoji) {
        alreadyReacted = true;
        break;
      }
    }

    const emojiToSend = alreadyReacted ? '' : emoji;

    try {
      await messageApi.react(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        emoji: emojiToSend,
      });

      // Deep-merge metadata.reactions so existing media / quotedMessage on metadata survive.
      const key = messagesQueryKey(selectedSessionId, activeChat.id);
      updateCachedMessages(queryClient, key, old =>
        old.map(m => {
          if (m.type !== 'revoked' && (m.id === msg.id || m.waMessageId === msg.id)) {
            const metadata = m.metadata || {};
            const reactions = { ...(metadata.reactions || {}) };
            if (emojiToSend === '') {
              delete reactions['me'];
            } else {
              reactions['me'] = emojiToSend;
            }
            return { ...m, metadata: { ...metadata, reactions } };
          }
          return m;
        }),
      );
    } catch (err) {
      showErrorToast(t('chats.errors.react'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleDeleteMessage = async (msg: ChatMessageView) => {
    if (!selectedSessionId || !activeChat) return;
    const msgId = msg.waMessageId || msg.id;

    if (!window.confirm(t('chats.deleteConfirm'))) return;

    try {
      await messageApi.delete(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        forEveryone: true,
      });

      updateMessage(selectedSessionId, activeChat.id, msg.id, { body: '', type: 'revoked', metadata: undefined });
    } catch (err) {
      showErrorToast(t('chats.errors.delete'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleClickButton = async (msg: ChatMessageView, button: { id: string; text: string }) => {
    if (!selectedSessionId || !activeChat) return;
    const msgId = msg.waMessageId || msg.id;
    try {
      await messageApi.clickButton(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        buttonId: button.id,
        text: button.text,
      });
    } catch (err) {
      showErrorToast(t('chats.errors.clickButton'), err instanceof Error ? err.message : undefined);
      throw err;
    }
  };

  // Side effects when the active chat changes: mark-as-read on the gateway + clear sidebar unread badge.
  // The message-history fetch is driven by useChatMessages; scroll restoration is driven by
  // useChatScrollPosition (both keyed off activeChat?.id). Deliberately keying off `activeChat?.id`
  // (not the whole object) so a sidebar reshuffle that mutates the activeChat instance doesn't re-fire
  // the mark-as-read RPC for the same chat.
  useEffect(() => {
    if (!activeChat) return;
    // Opening a chat is what reads it again after Mark as unread.
    keptUnread.delete(readKey(selectedSessionId, activeChat.id));
    markChatRead(activeChat.id);
    // A read-only key sends no mark-as-read, so the chat stays unread on the gateway; clearing the
    // badge here would only have the next chat-list load bring it back.
    if (canWrite) setChats(prev => prev.map(c => (c.id === activeChat.id ? { ...c, unreadCount: 0 } : c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id, markChatRead, canWrite]);

  // --- Global search: jump to a hit's chat (and best-effort scroll to the message) ---
  // A cross-session hit switches session, which asynchronously reloads the chats list — so the
  // target chat may not be available at click time. pendingHitRef carries the intent across that
  // async gap: the chat-select effect picks it up once the list lands, and the scroll effect runs
  // once the messages have rendered. `opened` marks a hit whose chat has been opened, so the user
  // leaving that chat before its thread renders drops the hit instead of being sent back into it.
  const pendingHitRef = useRef<{ sessionId: string; chatId: string; waMessageId: string; opened?: boolean } | null>(
    null,
  );
  // Bumped with every hit, so a hit in the chat already open still re-runs the scroll effect, where
  // every other state it sets is unchanged and React skips the render.
  const [hitSeq, setHitSeq] = useState(0);

  const handleSearchHit = useCallback(
    async (hit: SearchHit) => {
      // Search covers stored messages of every session, but the page can only open a ready one, and
      // its list is read on mount. A session missing from it is looked up again, since it may have
      // connected since; one that still is not ready is refused rather than selected with no chats.
      if (hit.sessionId !== selectedSessionId && !sessions.some(s => s.id === hit.sessionId)) {
        let ready: Session[];
        try {
          ready = (await sessionApi.list()).filter(s => s.status === 'ready');
        } catch (err) {
          showLoadError('chats.errors.loadSessions', err);
          return;
        }
        if (!ready.some(s => s.id === hit.sessionId)) {
          pendingHitRef.current = null;
          showWarningToast(t('chats.errors.searchHitSessionNotReady'));
          return;
        }
        setSessions(ready);
      }
      const pending = { sessionId: hit.sessionId, chatId: hit.chatId, waMessageId: hit.waMessageId };
      pendingHitRef.current = pending;
      setHitSeq(n => n + 1);
      if (hit.sessionId !== selectedSessionId) {
        // Switching session triggers loadChats; the effect below selects the chat once the list lands.
        setSelectedSessionId(hit.sessionId);
      } else {
        const chat = chats.find(c => c.id === hit.chatId);
        if (chat) {
          if (chat.kind === 'channel') {
            // Channels render their own read-only list on the Channels tab, not via activeChat — the
            // hit's message-highlight is intentionally dropped here since that pane has no per-message scroll target.
            switchTab('channels');
            pendingHitRef.current = null;
          } else {
            setActiveTab(chat.kind === 'status' ? 'status' : 'chats');
            setActiveChat(chat);
            setActiveChannel(null);
            setActiveStatusContactId(null);
            pendingHitRef.current = { ...pending, opened: true };
          }
        } else {
          pendingHitRef.current = null;
        }
      }
    },
    [selectedSessionId, sessions, chats, switchTab, showLoadError, showWarningToast, t],
  );

  // After a session switch the chats list reloads — pick up the pending chat once it appears.
  // While the switch's list is loading, `chats` still holds the previous session's list, which can
  // list the same id (a shared group or contact) as a Chat object from the other account. A hit whose
  // chat the session's list lacks, or whose session the user left, is dropped: it would otherwise open
  // on its own once a later list holds that id.
  useEffect(() => {
    const pending = pendingHitRef.current;
    if (!pending) return;
    if (pending.sessionId !== selectedSessionId || (pending.opened && activeChat?.id !== pending.chatId)) {
      pendingHitRef.current = null;
      return;
    }
    if (loadingChats || listedSessionRef.current !== pending.sessionId || activeChat?.id === pending.chatId) return;
    const chat = chats.find(c => c.id === pending.chatId);
    if (!chat) {
      pendingHitRef.current = null;
    } else if (chat.kind === 'channel') {
      switchTab('channels');
      pendingHitRef.current = null;
    } else {
      setActiveTab(chat.kind === 'status' ? 'status' : 'chats');
      setActiveChat(chat);
      setActiveChannel(null);
      setActiveStatusContactId(null);
      pendingHitRef.current = { ...pending, opened: true };
    }
  }, [chats, loadingChats, activeChat, selectedSessionId, switchTab]);

  // Best-effort scroll to the hit message. Runs as a layout effect (after useChatScrollPosition's
  // own restore on the same commit) so it overrides the bottom/saved jump with no visible flash.
  // Degrades silently to session+chat selection when the element isn't present — the message is
  // still visible in the conversation. Until the hit's session has its list on screen, the open chat
  // still belongs to the session being left, even when it has the hit's chat id.
  useLayoutEffect(() => {
    const pending = pendingHitRef.current;
    if (!pending || listedSessionRef.current !== pending.sessionId || activeChat?.id !== pending.chatId) return;
    if (loadingMessages || messages.length === 0) return;
    const container = messagesContainerRef.current;
    if (container) {
      try {
        const el = container.querySelector(`[data-wa-message-id="${pending.waMessageId}"]`);
        if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center' });
      } catch {
        // Unexpected chars in the id made the selector invalid — ignore.
      }
    }
    pendingHitRef.current = null;
  }, [activeChat, loadingMessages, messages, messagesContainerRef, hitSeq]);

  // Helper formats
  const formatChatTime = useCallback(
    (timestamp?: number) => {
      if (!timestamp) return '';
      const date = new Date(timestamp * 1000);
      const today = new Date();
      if (date.toDateString() === today.toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) {
        return t('chats.yesterday');
      }
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    },
    [t],
  );

  // One search box drives all three tabs; each matches on its own fields. Plain consts (not useMemo)
  // because chats/channelsQuery.data/statusesQuery.data are already stable, query-cached references,
  // so re-filtering on every render is cheap. See utils/chatFilters for the two status orderings.
  // Whether a 1:1 chat's contact is saved comes from the address book (`isMyContact`), not from its
  // display name: Baileys names an unsaved contact by its bare push name too. Undefined until it loads.
  const contactsQuery = useQuery({
    queryKey: ['contacts', selectedSessionId],
    queryFn: () => contactApi.list(selectedSessionId),
    enabled: Boolean(selectedSessionId),
    staleTime: 5 * 60 * 1000,
    // contactApi.list already retried a throttled page; another attempt would walk every page again.
    retry: false,
  });
  const savedContactKeys = useMemo(() => savedContactKeySet(contactsQuery.data), [contactsQuery.data]);

  const searching = searchQuery.trim() !== '';
  const searchedChats = filterChats(chats, searchQuery);
  const archivedCount = filterChats(chats, '').filter(c => c.archived).length;
  const shownChats = applyChatListFilter(
    searching ? searchedChats : searchedChats.filter(c => c.archived === showArchived),
    chatFilter,
    savedContactKeys,
  );
  const filteredChats = showArchived
    ? shownChats
    : [...shownChats.filter(c => c.pinned), ...shownChats.filter(c => !c.pinned)];

  // Open a chat picked in the new-chat panel. A chat with no history is not in the engine's list, so
  // it is added to the sidebar locally until the first message, or the next list load, settles it.
  // The filter and search are cleared so the opened chat is visible in the list. A chat the panel found
  // through another session (a lookup that answered after a switch) is dropped: opening it here would
  // send the next message through the wrong account.
  const handleOpenNewChat = (chat: Chat, sessionId: string) => {
    if (sessionId !== selectedSessionRef.current) return;
    const existing = chats.find(c => c.id === chat.id);
    if (!existing) setChats(prev => [chat, ...prev]);
    setActiveTab('chats');
    setActiveChannel(null);
    setActiveStatusContactId(null);
    setActiveChat(existing ?? chat);
    setShowNewChat(false);
    setChatFilter('all');
    setSearchQuery('');
  };

  // Chat row actions. Everything but the info views is an operator route, so a read-only key gets only those.
  //
  // Every action is bound to the session it started in. Two sessions can list the same chat id (a group
  // both accounts are in), and a request that answers after a switch changed only the session it went to:
  // its result must not land on the list or the open chat of the session now selected.
  const stillOn = (sessionId: string) => sessionId === selectedSessionRef.current;

  const renameChat = useCallback((sessionId: string, chatId: string, name: string) => {
    if (sessionId !== selectedSessionRef.current) return;
    setChats(prev => prev.map(c => (c.id === chatId ? { ...c, name } : c)));
    setActiveChat(prev => (prev?.id === chatId ? { ...prev, name } : prev));
  }, []);

  // Several chat routes answer HTTP 200 with `{ success: false }` when the engine declined to act (WhatsApp
  // keeps at most three chats pinned; Baileys cannot clear or delete a chat it knows no last message of),
  // which is a failure here: nothing changed, so nothing local changes either.
  const expectSuccess = (result: { success: boolean }) => {
    if (!result.success) throw new Error(t('chats.rowActions.declined'));
  };
  const failWith = (key: string) => (err: unknown) =>
    showErrorToast(t(key), err instanceof Error ? err.message : undefined);

  const patchChat = (sessionId: string, chatId: string, patch: Partial<Chat>) => {
    if (!stillOn(sessionId)) return;
    setChats(prev => prev.map(c => (c.id === chatId ? { ...c, ...patch } : c)));
    setActiveChat(prev => (prev?.id === chatId ? { ...prev, ...patch } : prev));
  };

  const handleMarkUnread = async (chat: Chat) => {
    const sessionId = selectedSessionId;
    const key = readKey(sessionId, chat.id);
    keptUnread.add(key);
    markReadCoalescer.drop(chat.id);
    try {
      await readsInFlight.get(key);
      expectSuccess(await sessionApi.markChatUnread(sessionId, chat.id));
      if (!stillOn(sessionId)) return;
      // A negative count is how the list shows a chat marked unread (a badge with no number).
      patchChat(sessionId, chat.id, { unreadCount: -1 });
      if (activeChatIdRef.current === chat.id) setActiveChat(null);
    } catch (err) {
      keptUnread.delete(key);
      failWith('chats.rowActions.markUnreadFailed')(err);
    }
  };

  // The blocklist decides whether a 1:1 chat offers Block or Unblock. Only a key that can act on it reads it.
  const blockedQuery = useQuery({
    queryKey: ['contacts-blocked', selectedSessionId],
    queryFn: () => contactApi.listBlocked(selectedSessionId),
    enabled: Boolean(selectedSessionId) && canWrite,
    staleTime: 60_000,
    retry: false,
  });
  const isBlocked = (chat: Chat) =>
    (blockedQuery.data ?? []).some(id => id === chat.id || id.split('@')[0] === chat.id.split('@')[0]);

  // The address book is keyed by phone number, so a contact can be saved only under a phone-based id: the
  // chat's own when it has one, else, for the open chat, the number the engine resolved for its @lid. The
  // digits of a @lid are no phone number and are never used as one.
  const addressbookIdOf = (chat: Chat): string | null =>
    phoneContactId(chat.id) ??
    (chat.id === activeChat?.id && resolvedPhoneQ.data ? `${resolvedPhoneQ.data.replace(/\D/g, '')}@c.us` : null);

  const handleTogglePin = (chat: Chat) => {
    const sessionId = selectedSessionId;
    return sessionApi
      .pinChat(sessionId, chat.id, !chat.pinned)
      .then(expectSuccess)
      .then(() => patchChat(sessionId, chat.id, { pinned: !chat.pinned }))
      .catch(failWith(chat.pinned ? 'chats.rowActions.unpinFailed' : 'chats.rowActions.pinFailed'));
  };

  const handleToggleArchive = (chat: Chat) => {
    const sessionId = selectedSessionId;
    return sessionApi
      .archiveChat(sessionId, chat.id, !chat.archived)
      .then(expectSuccess)
      .then(() => {
        showSuccessToast(t(chat.archived ? 'chats.rowActions.unarchived' : 'chats.rowActions.archived'));
        patchChat(sessionId, chat.id, { archived: !chat.archived });
      })
      .catch(failWith('chats.rowActions.archiveFailed'));
  };

  const MUTE_FOREVER = Date.UTC(2100, 0, 1);
  const handleMute = async (chat: Chat, duration: MuteDuration | null) => {
    const sessionId = selectedSessionId;
    const until =
      duration === null
        ? null
        : duration === 'always'
          ? MUTE_FOREVER
          : Date.now() + (duration === '8h' ? 8 * 3_600_000 : 7 * 86_400_000);
    setDialogBusy(true);
    try {
      expectSuccess(await sessionApi.muteChat(sessionId, chat.id, until));
      // The list reports an indefinite mute as expiry 0.
      patchChat(sessionId, chat.id, {
        muted: until !== null,
        muteExpiration: until === null ? undefined : duration === 'always' ? 0 : until,
      });
      if (stillOn(sessionId)) setMuteDialogChat(null);
    } catch (err) {
      failWith('chats.rowActions.muteFailed')(err);
    } finally {
      setDialogBusy(false);
    }
  };

  const handleSaveContact = async (chat: Chat, firstName: string, lastName: string) => {
    const sessionId = selectedSessionId;
    const contactId = addressbookIdOf(chat);
    if (!contactId) return;
    setDialogBusy(true);
    try {
      expectSuccess(await contactApi.upsert(sessionId, contactId, firstName, lastName || undefined));
      showSuccessToast(t('chats.rowActions.contactSaved'));
      void queryClient.invalidateQueries({ queryKey: ['contacts', sessionId] });
      renameChat(sessionId, chat.id, [firstName, lastName].filter(Boolean).join(' '));
      if (stillOn(sessionId)) setContactDialogChat(null);
    } catch (err) {
      failWith('chats.rowActions.contactSaveFailed')(err);
    } finally {
      setDialogBusy(false);
    }
  };

  const handleUnblock = (chat: Chat) => {
    const sessionId = selectedSessionId;
    return contactApi
      .unblock(sessionId, chat.id)
      .then(expectSuccess)
      .then(() => {
        showSuccessToast(t('chats.rowActions.unblocked', { name: chat.name || chat.id.split('@')[0] }));
        return queryClient.invalidateQueries({ queryKey: ['contacts-blocked', sessionId] });
      })
      .catch(failWith('chats.rowActions.blockFailed'));
  };

  const rowActions: ChatRowActions = {
    onGroupInfo: setGroupDialogChat,
    onSaveContact: canWrite ? setContactDialogChat : undefined,
    canSaveContact: chat => addressbookIdOf(chat) !== null,
    isSavedContact: chat => savedContactKeys?.has(contactKey(chat.id)) ?? false,
    onTogglePin: canWrite ? chat => void handleTogglePin(chat) : undefined,
    onMute: canWrite ? chat => (chat.muted ? void handleMute(chat, null) : setMuteDialogChat(chat)) : undefined,
    onToggleArchive: canWrite ? chat => void handleToggleArchive(chat) : undefined,
    onMarkUnread: canWrite ? chat => void handleMarkUnread(chat) : undefined,
    onLeaveGroup: canWrite ? chat => setConfirmAction({ kind: 'leave', chat }) : undefined,
    onToggleBlock: canWrite
      ? chat => (isBlocked(chat) ? void handleUnblock(chat) : setConfirmAction({ kind: 'block', chat }))
      : undefined,
    onClear: canClearOrDelete ? chat => setConfirmAction({ kind: 'clear', chat }) : undefined,
    onDelete: canClearOrDelete ? chat => setConfirmAction({ kind: 'delete', chat }) : undefined,
    isBlocked,
  };

  // Leaving a group, clearing a chat and deleting one all run from the confirmation dialog. On success the
  // dialog closes; on a failure, a declined one included, it stays open, so the action can be tried again.
  // A switch closes the dialog, and a request that answers after it changes nothing on the new session.
  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    const { kind, chat } = confirmAction;
    const sessionId = selectedSessionId;
    const name = chat.name || chat.id.split('@')[0];
    setConfirmBusy(true);
    try {
      if (kind === 'leave') {
        expectSuccess(await sessionApi.leaveGroup(sessionId, chat.id));
        showSuccessToast(t('chats.group.left', { name }));
        if (stillOn(sessionId)) void loadChats(sessionId, { background: true });
      } else if (kind === 'block') {
        expectSuccess(await contactApi.block(sessionId, chat.id));
        showSuccessToast(t('chats.rowActions.blocked', { name }));
        await queryClient.invalidateQueries({ queryKey: ['contacts-blocked', sessionId] });
      } else if (kind === 'clear') {
        expectSuccess(await sessionApi.clearChatMessages(sessionId, chat.id));
        showSuccessToast(t('chats.rowActions.cleared', { name }));
        patchChat(sessionId, chat.id, { lastMessage: '', unreadCount: 0 });
        // The thread cache holds the messages just deleted; the next open reads the empty chat.
        await queryClient.invalidateQueries({ queryKey: messagesQueryKey(sessionId, chat.id) });
      } else {
        expectSuccess(await sessionApi.deleteChat(sessionId, chat.id));
        showSuccessToast(t('chats.rowActions.deleted', { name }));
        if (stillOn(sessionId)) setChats(prev => prev.filter(c => c.id !== chat.id));
        queryClient.removeQueries({ queryKey: messagesQueryKey(sessionId, chat.id) });
      }
      if (!stillOn(sessionId)) return;
      if ((kind === 'leave' || kind === 'delete') && activeChatIdRef.current === chat.id) setActiveChat(null);
      setConfirmAction(null);
    } catch (err) {
      const failed =
        kind === 'leave'
          ? 'chats.group.leaveFailed'
          : kind === 'block'
            ? 'chats.rowActions.blockFailed'
            : kind === 'clear'
              ? 'chats.rowActions.clearFailed'
              : 'chats.rowActions.deleteFailed';
      failWith(failed)(err);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleCopyChatId = async () => {
    if (!activeChat) return;
    setRoomMenuOpen(false);
    try {
      await navigator.clipboard.writeText(activeChat.id);
      showSuccessToast(t('chats.chatIdCopied'));
    } catch (err) {
      showErrorToast(t('chats.copyFailed'), err instanceof Error ? err.message : undefined);
    }
  };

  // The overflow menu closes on a press outside it, on Escape, and with the chat it belongs to. Escape
  // is taken in the capture phase and marked handled, like the emoji picker's, so the page's own
  // handler below leaves the room open.
  useEffect(() => {
    setRoomMenuOpen(false);
  }, [activeChat?.id]);
  useEffect(() => {
    if (!roomMenuOpen) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!roomMenuRef.current?.contains(event.target as Node)) setRoomMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      setRoomMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [roomMenuOpen]);
  // The channels zero-state ("not subscribed to any channels") stays keyed on the UNFILTERED list
  // below, so a non-matching search renders an empty list rather than claiming there are none.
  const filteredChannels = filterChannels(channelsQuery.data ?? [], searchQuery);
  const groupedStatuses: ContactStatusGroup[] = groupStatusesByContact(statusesQuery.data ?? [], searchQuery);

  // The open status group, derived — see the activeStatusContactId declaration.
  const activeStatusGroup = activeStatusContactId
    ? (groupedStatuses.find(g => g.contact.id === activeStatusContactId) ?? null)
    : null;

  // The pane heading truncates with an ellipsis, so the untruncated text has to reach the tooltip.
  const activeStatusTitle = activeStatusGroup
    ? (activeStatusGroup.contact.name ?? activeStatusGroup.contact.pushName ?? activeStatusGroup.contact.id)
    : '';

  // Same open-at-newest behavior for the status viewer pane, keyed off the active contact and its
  // item list. Declared after activeStatusGroup: the viewer follows refetches because the deps are
  // the derived group's items, not a click-time snapshot.
  const statusFeedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = statusFeedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeStatusGroup?.contact.id, activeStatusGroup?.items]);

  // Escape closes the open view and returns to the list. Anything that owns the key already keeps
  // it: a modal (Modal renders role="dialog" only while open) and the language menu (role="menu")
  // are skipped here, and so is the media viewer, whose library renders its own role="dialog"
  // portal and closes itself on Escape. A handler that called preventDefault, or a composition
  // still being committed by an IME, is left alone for the same reason.
  useEffect(() => {
    const closeOpenViewOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (activeStatusContactId !== null) setActiveStatusContactId(null);
      else if (activeChannel) setActiveChannel(null);
      else if (activeChat) setActiveChat(null);
      else if (showNewChat) setShowNewChat(false);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', closeOpenViewOnEscape);
    return () => document.removeEventListener('keydown', closeOpenViewOnEscape);
  }, [activeStatusContactId, activeChannel, activeChat, showNewChat]);

  // Image media items for the lightbox, in render order. `getMediaSrc` reconstructs a usable src
  // from either a base64 payload or a URL — the ChatMessageView shape stores both in `data`.
  const imageMedia = useMemo<LightboxItem[]>(
    () =>
      messages
        .filter(m => m.type === 'image' && Boolean(getMediaSrc(m.metadata?.media)))
        .map(m => ({
          id: m.id,
          url: getMediaSrc(m.metadata?.media),
          alt: m.body || m.metadata?.media?.filename || '',
          filename: m.metadata?.media?.filename,
          senderName: undefined,
          timestamp: formatChatTime(m.timestamp || Math.floor(new Date(m.createdAt).getTime() / 1000)),
        })),
    [messages, formatChatTime],
  );

  return (
    <div className="chats-page">
      <PageHeader
        title={t('nav.chats')}
        subtitle={t('chats.subtitle')}
        actions={
          sessions.length > 0 &&
          canWrite && <GlobalSearch currentSessionId={selectedSessionId} onHit={handleSearchHit} />
        }
      />

      {/* Real-time connection permanently dropped — let the user re-establish it instead of
          silently showing stale chats. */}
      {connectionFailed && (
        <div className="chats-reconnect-banner" role="alert">
          <AlertCircle size={16} />
          <span>{t('common.disconnected')}</span>
          <button className="btn-secondary" onClick={reconnect}>
            {t('common.refresh')}
          </button>
        </div>
      )}

      {loadingSessions ? (
        <div className="chats-loading-container">
          <Loader2 className="animate-spin" size={32} />
          <p>{t('common.loading')}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="chats-error-state">
          <AlertCircle size={48} className="text-warn" />
          <h3>{t('chats.noSessionsTitle')}</h3>
          <p>
            <Trans i18nKey="chats.noSessionsDesc">
              Please connect a WhatsApp session from the <strong>Sessions</strong> menu first to use the chat feature.
            </Trans>
          </p>
        </div>
      ) : (
        <div className={`chats-layout ${activeChat || activeChannel || activeStatusGroup ? 'has-active-chat' : ''}`}>
          {/* LEFT SIDEBAR: session & chat rooms */}
          <ChatSidebar
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
            activeTab={activeTab}
            onSwitchTab={switchTab}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onComposeStatus={() => setComposeOpen(true)}
            onNewChat={canWrite ? () => setShowNewChat(true) : undefined}
            newChatPanel={
              canWrite && showNewChat ? (
                <NewChatPanel
                  sessionId={selectedSessionId}
                  onOpenChat={handleOpenNewChat}
                  onClose={() => setShowNewChat(false)}
                />
              ) : null
            }
            formatChatTime={formatChatTime}
            chatsTab={{
              loading: loadingChats,
              chats: filteredChats,
              activeChatId: activeChat?.id,
              pictures: listPics.data,
              onSelectChat: setActiveChat,
              filter: chatFilter,
              onFilterChange: setChatFilter,
              rowActions,
              archive: { count: archivedCount, showing: showArchived, onToggle: () => setShowArchived(v => !v) },
            }}
            channelsTab={{
              engineLoading: engineType === null,
              supported: channelsSupported,
              query: channelsQuery,
              channels: filteredChannels,
              activeChannelId: activeChannel?.id,
              onSelectChannel: setActiveChannel,
            }}
            statusTab={{
              loading: statusesQuery.isLoading,
              error: statusesQuery.isError,
              groups: groupedStatuses,
              activeContactId: activeStatusContactId,
              onSelectContact: setActiveStatusContactId,
            }}
          />

          {/* RIGHT VIEW: active chat room */}
          <main className="chats-room">
            {activeChat ? (
              <div className="room-container">
                {/* Room header */}
                <header className="room-header">
                  <button className="room-back" onClick={() => setActiveChat(null)} aria-label={t('common.back')}>
                    <ArrowLeft size={20} />
                  </button>
                  <div className="room-avatar">
                    {activePp.data ? (
                      <img
                        src={activePp.data}
                        alt=""
                        // Signed CDN URLs rotate every few hours; refetch the slice on a stale load.
                        onError={() => activePp.refetch()}
                      />
                    ) : (
                      <KindIcon kind={activeChat.kind} />
                    )}
                  </div>
                  <div className="room-contact-info">
                    <h3>{activeChat.name || activeChat.id.split('@')[0]}</h3>
                    {/* Personal chats show the prettified phone number — local formatting for
                        @c.us ids, engine-resolved for @lid privacy ids (which are NOT phones and
                        must never be formatted as one). Groups fall back to a semantic label;
                        the raw JID follows below for the technical case. */}
                    <span className="room-contact-phone">
                      {activePhoneText ??
                        (activeChat.isGroup ? t('chats.groupSubtitle') : t('chats.privateContactSubtitle'))}
                    </span>
                    {/* Raw JID preserved for the technical case (the gateway speaks JIDs everywhere:
                        webhooks, message rows, lid resolution). Monospace + muted so it doesn't compete
                        with the human-facing name/number. */}
                    <span className="room-contact-jid" title={activeChat.id}>
                      {activeChat.id}
                    </span>
                  </div>
                  <div className="room-header-actions">
                    <div className="room-menu" ref={roomMenuRef}>
                      <button
                        type="button"
                        className={`icon-btn room-menu-trigger ${roomMenuOpen ? 'active' : ''}`}
                        onClick={() => setRoomMenuOpen(open => !open)}
                        title={t('chats.moreActions')}
                        aria-label={t('chats.moreActions')}
                        aria-expanded={roomMenuOpen}
                      >
                        <CircleEllipsis size={22} />
                      </button>
                      {/* A disclosure of plain buttons, not role="menu": it keeps no roving focus or arrow
                          keys, and the role would promise them. */}
                      {roomMenuOpen && (
                        <div className="room-menu-popover">
                          {/* The row's actions, then what only an open room needs. */}
                          <ChatActions chat={activeChat} actions={rowActions} onPicked={() => setRoomMenuOpen(false)} />
                          <hr />
                          <button type="button" onClick={() => void handleCopyChatId()}>
                            <Copy size={16} />
                            {t('chats.copyChatId')}
                          </button>
                          <button type="button" onClick={() => setActiveChat(null)}>
                            <X size={16} />
                            {t('chats.closeChat')}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </header>

                {/* Messages body (list, media, reactions, scroll-to-bottom) — components/chats/ChatThread. */}
                <ChatThread
                  sessionId={selectedSessionId}
                  activeChat={activeChat}
                  messages={messages}
                  loadingMessages={loadingMessages}
                  messagesError={messagesError}
                  messagesContainerRef={messagesContainerRef}
                  hasMoreMessages={Boolean(hasMoreMessages)}
                  loadingOlderMessages={loadingOlderMessages}
                  onLoadOlderMessages={handleLoadOlderMessages}
                  onMediaLoad={onMediaLoad}
                  measureMedia={measureMedia}
                  onOpenImage={messageId => {
                    const idx = imageMedia.findIndex(x => x.id === messageId);
                    if (idx >= 0) setLightboxIndex(idx);
                  }}
                  onReply={setReplyingTo}
                  onReact={handleReactMessage}
                  onDelete={handleDeleteMessage}
                  onClickButton={handleClickButton}
                />

                {/* Composer: attachment preview, emoji panel, reply banner, input bar —
                    components/chats/ChatComposer. */}
                <ChatComposer
                  selectedSessionId={selectedSessionId}
                  activeChat={activeChat}
                  replyingTo={replyingTo}
                  setReplyingTo={setReplyingTo}
                  onMessageAppended={onMessageAppended}
                  onSent={promoteSentChat}
                  messageInput={messageInput}
                  setMessageInput={setMessageInput}
                  attachment={attachment}
                  setAttachment={setAttachment}
                  previewUrl={previewUrl}
                  setPreviewUrl={setPreviewUrl}
                />
              </div>
            ) : activeChannel ? (
              // Read-only channel pane: no send footer, reactions, delete, reply, or markChatRead —
              // subscribed channels are a broadcast feed, not a two-way conversation.
              <div key={activeChannel.id} className="channel-room">
                <header className="chats-room-header">
                  <button className="room-back" onClick={() => setActiveChannel(null)} aria-label={t('common.back')}>
                    <ArrowLeft size={20} />
                  </button>
                  <Megaphone size={20} />
                  <h2 title={activeChannel.name}>{activeChannel.name}</h2>
                </header>
                <div className="messages-list" ref={channelFeedRef}>
                  {channelMessages.isLoading ? (
                    <div className="messages-loading">
                      <Loader2 className="animate-spin" size={32} />
                      <span>{t('chats.loadingMessages')}</span>
                    </div>
                  ) : channelMessages.error ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.loadMessagesError')}</span>
                    </div>
                  ) : (channelMessages.data ?? []).length === 0 ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.noMessagesInChat')}</span>
                    </div>
                  ) : (
                    (channelMessages.data ?? []).map(m => (
                      <div key={m.id} className="message-bubble incoming">
                        {/* whatsapp-web.js flags a post's media but gives no URL for it. */}
                        {m.hasMedia &&
                          (m.mediaUrl ? (
                            <img className="channel-media" src={m.mediaUrl} alt="" />
                          ) : (
                            <span className="status-media-placeholder">{t('chats.status.mediaUnavailable')}</span>
                          ))}
                        {m.body && <MessageBody text={stripMentionDelimiters(m.body)} className="message-text" />}
                        <span className="message-time">{formatChatTime(m.timestamp)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : activeStatusGroup ? (
              // Read-only status viewer: no send footer, reactions, delete, reply, or markChatRead —
              // statuses are ephemeral broadcast posts, not a two-way conversation.
              <div key={activeStatusGroup.contact.id} className="channel-room">
                <header className="chats-room-header">
                  <button
                    className="room-back"
                    onClick={() => setActiveStatusContactId(null)}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <CircleDashed size={20} />
                  <h2 title={activeStatusTitle}>{activeStatusTitle}</h2>
                </header>
                <div className="messages-list" ref={statusFeedRef}>
                  {activeStatusGroup.items.map(item => (
                    <div
                      key={item.id}
                      className="message-bubble incoming"
                      // A text status keeps the look it was posted with: background colour (white
                      // text like WhatsApp) and the closest generic font family we have for the
                      // proprietary WhatsApp font slots.
                      style={
                        item.type === 'text' && (item.backgroundColor || item.font)
                          ? {
                              ...(item.backgroundColor ? { backgroundColor: item.backgroundColor, color: '#fff' } : {}),
                              ...statusFontStyle(item.font),
                            }
                          : undefined
                      }
                    >
                      {item.mediaUrl && (
                        <StatusMedia
                          sessionId={selectedSessionId || null}
                          statusId={item.id}
                          type={item.type === 'video' ? 'video' : item.type === 'voice' ? 'audio' : 'image'}
                        />
                      )}
                      {item.caption && (
                        <MessageBody text={stripMentionDelimiters(item.caption)} className="message-text" />
                      )}
                      <span className="message-time">
                        {formatChatTime(Math.floor(new Date(item.timestamp).getTime() / 1000))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chats-room-placeholder">
                <MessageSquare size={80} className="placeholder-icon" />
                <h2>{t('chats.placeholderTitle')}</h2>
                <p>{t('chats.placeholderDesc')}</p>
              </div>
            )}
          </main>
        </div>
      )}

      <MediaLightbox
        items={imageMedia}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
      />

      {groupDialogChat && sessions.some(s => s.id === selectedSessionId) && (
        <GroupInfoDialog
          session={sessions.find(s => s.id === selectedSessionId)!}
          group={groupDialogChat}
          onClose={() => setGroupDialogChat(null)}
          onRenamed={renameChat}
        />
      )}

      {confirmAction && (
        <Modal
          open
          onClose={() => setConfirmAction(null)}
          title={t(CONFIRM_TEXT[confirmAction.kind].title)}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setConfirmAction(null)} disabled={confirmBusy}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void runConfirmedAction()} disabled={confirmBusy}>
                {confirmBusy ? (
                  <Loader2 className="animate-spin" size={16} />
                ) : (
                  t(CONFIRM_TEXT[confirmAction.kind].title)
                )}
              </button>
            </>
          }
        >
          <p>
            {t(CONFIRM_TEXT[confirmAction.kind].question, {
              name: confirmAction.chat.name || confirmAction.chat.id.split('@')[0],
            })}
          </p>
          <p className="text-muted">{t(CONFIRM_TEXT[confirmAction.kind].warning)}</p>
        </Modal>
      )}

      {muteDialogChat && (
        <MuteChatDialog
          chat={muteDialogChat}
          busy={dialogBusy}
          onMute={duration => void handleMute(muteDialogChat, duration)}
          onClose={() => setMuteDialogChat(null)}
        />
      )}

      {contactDialogChat && (
        <SaveContactDialog
          chat={contactDialogChat}
          busy={dialogBusy}
          onSave={(first, last) => void handleSaveContact(contactDialogChat, first, last)}
          onClose={() => setContactDialogChat(null)}
        />
      )}

      {composeOpen && (
        <StatusComposeModal
          sessionId={selectedSessionId}
          onClose={() => setComposeOpen(false)}
          onPosted={() => statusesQuery.refetch()}
        />
      )}
    </div>
  );
}
