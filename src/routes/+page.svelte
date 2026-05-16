<script lang="ts">
	import { tick, onMount, setContext } from 'svelte';
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { id } from '@instantdb/svelte';
	import { db } from '$lib/db';
	import {
		Plus,
		X,
		LogIn,
		LogOut,
		ChevronLeft,
		ChevronRight,
		Download,
		Settings,
		MessageCircle,
		Columns2,
		HashIcon,
		Trash2
	} from '$lib/icons';
	import Avatar from '$lib/Avatar.svelte';
	import ChatPane from '$lib/ChatPane.svelte';
	import DebugHUD from '$lib/DebugHUD.svelte';
	import { avatarColor, initials } from '$lib/avatar';
	import { dmKeyFor, dmOtherName, dmOtherUserId, roomDisplayName, toMs } from '$lib/chatUtils';
	import { confirmDialog } from '$lib/confirm.svelte';
	import {
		Sun,
		Moon,
		Monitor,
		User,
		Palette,
		Paperclip,
		FileVideo,
		Image as ImageIcon,
		Loader2
	} from '@lucide/svelte';

	type Theme = 'light' | 'dark' | 'system';
	type MediaAutoload = 'all' | 'images' | 'none';
	type Accent =
		| 'indigo'
		| 'violet'
		| 'emerald'
		| 'teal'
		| 'sky'
		| 'rose'
		| 'amber'
		| 'orange';

	const ACCENTS: { value: Accent; label: string; cssVar: string }[] = [
		{ value: 'indigo', label: 'Indigo', cssVar: '--color-indigo-500' },
		{ value: 'violet', label: 'Violet', cssVar: '--color-violet-500' },
		{ value: 'emerald', label: 'Emerald', cssVar: '--color-emerald-500' },
		{ value: 'teal', label: 'Teal', cssVar: '--color-teal-500' },
		{ value: 'sky', label: 'Sky', cssVar: '--color-sky-500' },
		{ value: 'rose', label: 'Rose', cssVar: '--color-rose-500' },
		{ value: 'amber', label: 'Amber', cssVar: '--color-amber-500' },
		{ value: 'orange', label: 'Orange', cssVar: '--color-orange-500' }
	];

	// Signin / nickname flow state. `nickname` and `userId` are derived from the
	// authenticated user + their profile, not local state. See the auth section
	// below.
	let nicknameInput = $state('');
	let debugOpen = $state(false);
	let theme: Theme = $state('system');
	let accent: Accent = $state('indigo');
	let mediaAutoload: MediaAutoload = $state('all');
	let prefsOpen = $state(false);
	let prefsTab: 'profile' | 'appearance' = $state('appearance');
	let profileNameInput = $state('');
	let newRoomName = $state('');

	const MIN_PANE_WIDTH = 400;
	const PANE_GAP = 12;
	type Pane = { id: string; roomId: string | null };

	function loadInitialPanes(): { panes: Pane[]; focusedId: string } {
		const newId =
			typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'pane-0';
		const fallback = { panes: [{ id: newId, roomId: null as string | null }], focusedId: newId };
		if (typeof window === 'undefined') return fallback;
		const storedPanes = window.localStorage.getItem('chat:panes');
		if (storedPanes) {
			try {
				const parsed = JSON.parse(storedPanes) as { panes?: Pane[]; focusedId?: string };
				if (Array.isArray(parsed.panes) && parsed.panes.length > 0) {
					const restored = parsed.panes.map((p) => ({ id: p.id, roomId: p.roomId ?? null }));
					const focusedId =
						parsed.focusedId && restored.some((p) => p.id === parsed.focusedId)
							? parsed.focusedId
							: restored[0].id;
					return { panes: restored, focusedId };
				}
			} catch {}
		}
		const storedRoomId = window.localStorage.getItem('chat:activeRoomId');
		if (storedRoomId) fallback.panes[0].roomId = storedRoomId;
		return fallback;
	}

	const initialPanes = loadInitialPanes();
	let panes: Pane[] = $state(initialPanes.panes);
	let focusedPaneId: string = $state(initialPanes.focusedId);
	let paneRowWidth = $state(0);

	const focusedPane = $derived(panes.find((p) => p.id === focusedPaneId) ?? panes[0]);
	const activeRoomId = $derived(focusedPane?.roomId ?? null);
	const canSplit = $derived(
		paneRowWidth >= (panes.length + 1) * MIN_PANE_WIDTH + panes.length * PANE_GAP
	);

	function focusPaneId(id: string) {
		focusedPaneId = id;
	}

	function addPaneAfter(paneId: string) {
		if (!canSplit) return;
		const idx = panes.findIndex((p) => p.id === paneId);
		if (idx < 0) return;
		const newPane: Pane = { id: crypto.randomUUID(), roomId: null };
		panes = [...panes.slice(0, idx + 1), newPane, ...panes.slice(idx + 1)];
		focusedPaneId = newPane.id;
	}

	function closePane(paneId: string) {
		if (panes.length === 1) return;
		const idx = panes.findIndex((p) => p.id === paneId);
		if (idx < 0) return;
		const next = panes.filter((p) => p.id !== paneId);
		panes = next;
		if (focusedPaneId === paneId) {
			focusedPaneId = next[Math.max(0, idx - 1)].id;
		}
	}

	// Per-user hidden rooms (client-only). Key: roomId, Value: ms timestamp when hidden.
	// If a message arrives in the room with createdAt > hiddenAt, the room auto-unhides
	// (handled by the prune effect below). Explicitly navigating to a hidden room via
	// selectRoom also un-hides it.
	function loadHiddenRooms(): Record<string, number> {
		if (typeof window === 'undefined') return {};
		const raw = window.localStorage.getItem('chat:hiddenRooms');
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}
	let hiddenRoomTimestamps: Record<string, number> = $state(loadHiddenRooms());

	function isHidden(roomId: string): boolean {
		return hiddenRoomTimestamps[roomId] != null;
	}

	function unhideRoom(roomId: string) {
		if (hiddenRoomTimestamps[roomId] == null) return;
		const next = { ...hiddenRoomTimestamps };
		delete next[roomId];
		hiddenRoomTimestamps = next;
	}

	// Last-seen-at per room, client-only. A room is "unread" if it has a message
	// newer than lastSeenAt[roomId]. selectRoom updates it; an effect below also
	// auto-marks-read for rooms that are currently open in a pane while the tab
	// is visible (so passive viewing doesn't leave a stale unread badge).
	function loadLastSeen(): Record<string, number> {
		if (typeof window === 'undefined') return {};
		const raw = window.localStorage.getItem('chat:lastSeen');
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch {
			return {};
		}
	}
	let lastSeenAt: Record<string, number> = $state(loadLastSeen());
	let tabVisible = $state(
		typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
	);

	function markRead(roomId: string) {
		lastSeenAt = { ...lastSeenAt, [roomId]: Date.now() };
	}

	// Right-click menu on sidebar room/DM rows.
	let roomContextMenu: { x: number; y: number; roomId: string; isDm: boolean } | null =
		$state(null);

	function openRoomContextMenu(e: MouseEvent, roomId: string, isDm: boolean) {
		e.preventDefault();
		const menuWidth = 192;
		const menuHeight = 100;
		const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
		const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
		roomContextMenu = { x, y, roomId, isDm };
	}

	function closeRoomContextMenu() {
		roomContextMenu = null;
	}

	function leaveRoomFromMenu(roomId: string) {
		closeRoomContextMenu();
		hiddenRoomTimestamps = { ...hiddenRoomTimestamps, [roomId]: Date.now() };
		// Clear any pane currently viewing this room.
		panes = panes.map((p) => (p.roomId === roomId ? { ...p, roomId: null } : p));
	}

	async function deleteRoomFromMenu(roomId: string, isDm: boolean) {
		const room = chatQuery.data?.rooms.find((r) => r.id === roomId);
		if (!room) {
			closeRoomContextMenu();
			return;
		}
		const title = isDm
			? `Delete this DM with ${dmOtherName(room, myAliases, userId)}?`
			: `Delete the room "${room.name}"?`;
		const body = isDm
			? 'All messages will be lost for both of you.'
			: 'All messages will be lost for everyone.';
		closeRoomContextMenu();
		const ok = await confirmDialog({
			title,
			body,
			confirmLabel: 'Delete',
			destructive: true
		});
		if (!ok) return;

		try {
			if (isDm) {
				// DMs: regular client transact (perms allow participants).
				await db.transact(db.tx.rooms[roomId].delete());
			} else {
				// Non-DM rooms: admin-only, via server endpoint.
				const res = await adminFetch('/api/admin/delete-room', { roomId });
				if (!res.ok) {
					const errBody = await res.json().catch(() => ({}));
					throw new Error(errBody.error ?? res.statusText);
				}
			}
		} catch (err) {
			await confirmDialog({
				title: 'Delete failed',
				body: err instanceof Error ? err.message : String(err),
				confirmLabel: 'OK',
				hideCancel: true
			});
			return;
		}

		panes = panes.map((p) => (p.roomId === roomId ? { ...p, roomId: null } : p));
		if (hiddenRoomTimestamps[roomId] != null) {
			const next = { ...hiddenRoomTimestamps };
			delete next[roomId];
			hiddenRoomTimestamps = next;
		}
	}

	// Delete is gated: DMs by either party (both can leave). Non-DM rooms only
	// by admins — and that goes through /api/admin/delete-room rather than a
	// direct client transact, since perms reject non-admin room deletion.
	function canDeleteRoom(room: { kind?: string | null }): boolean {
		if (room.kind === 'dm') return true;
		return isAdmin;
	}

	function menuStopPropagation(e: MouseEvent) {
		e.stopPropagation();
	}

	if (typeof window !== 'undefined') {
		const storedTheme = window.localStorage.getItem('chat:theme') as Theme | null;
		if (storedTheme === 'light' || storedTheme === 'dark' || storedTheme === 'system') {
			theme = storedTheme;
		}
		const storedAccent = window.localStorage.getItem('chat:accent') as Accent | null;
		if (storedAccent && ACCENTS.some((a) => a.value === storedAccent)) {
			accent = storedAccent;
		}
		const storedAutoload = window.localStorage.getItem('chat:mediaAutoload') as MediaAutoload | null;
		if (storedAutoload === 'all' || storedAutoload === 'images' || storedAutoload === 'none') {
			mediaAutoload = storedAutoload;
		}
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		window.localStorage.setItem(
			'chat:panes',
			JSON.stringify({ panes, focusedId: focusedPaneId })
		);
	});

	// If a persisted room no longer exists once data has loaded, clear it from
	// any pane that referenced it. Only runs once on first data load — later
	// room creation (e.g. opening a DM) sets pane.roomId before InstantDB's
	// optimistic update is visible, so we don't want this firing repeatedly.
	let validatedPersistedRooms = false;
	$effect(() => {
		if (validatedPersistedRooms || !chatQuery.data) return;
		validatedPersistedRooms = true;
		const valid = new Set(chatQuery.data.rooms.map((r) => r.id));
		let changed = false;
		const next = panes.map((p) => {
			if (p.roomId && !valid.has(p.roomId)) {
				changed = true;
				return { ...p, roomId: null };
			}
			return p;
		});
		if (changed) panes = next;
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		window.localStorage.setItem('chat:hiddenRooms', JSON.stringify(hiddenRoomTimestamps));
	});

	// Prune hiddenRoomTimestamps: (1) auto-unhide rooms with newer messages than
	// the hide timestamp, (2) drop entries for rooms that no longer exist.
	$effect(() => {
		if (!chatQuery.data) return;
		const rooms = chatQuery.data.rooms;
		const live = new Set(rooms.map((r) => r.id));
		const next = { ...hiddenRoomTimestamps };
		let changed = false;
		for (const [roomId, hiddenAt] of Object.entries(hiddenRoomTimestamps)) {
			if (!live.has(roomId)) {
				delete next[roomId];
				changed = true;
				continue;
			}
			const room = rooms.find((r) => r.id === roomId);
			const newest = (room?.messages ?? []).reduce(
				(max, m) => Math.max(max, toMs(m.createdAt)),
				0
			);
			if (newest > hiddenAt) {
				delete next[roomId];
				changed = true;
			}
		}
		if (changed) hiddenRoomTimestamps = next;
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		window.localStorage.setItem('chat:lastSeen', JSON.stringify(lastSeenAt));
	});

	// Auto-mark-read for rooms currently open in a pane while the tab is visible.
	// Also prunes lastSeenAt entries for rooms that no longer exist.
	$effect(() => {
		if (!chatQuery.data) return;
		const rooms = chatQuery.data.rooms;
		const openRoomIds = new Set(panes.map((p) => p.roomId).filter((id): id is string => !!id));
		const live = new Set(rooms.map((r) => r.id));
		const next = { ...lastSeenAt };
		let changed = false;
		// Drop entries for rooms that are gone.
		for (const id of Object.keys(lastSeenAt)) {
			if (!live.has(id)) {
				delete next[id];
				changed = true;
			}
		}
		// Bump lastSeenAt for currently-visible open rooms with newer messages.
		if (tabVisible) {
			for (const room of rooms) {
				if (!openRoomIds.has(room.id)) continue;
				const newest = (room.messages ?? []).reduce(
					(max, m) => Math.max(max, toMs(m.createdAt)),
					0
				);
				if (newest > (next[room.id] ?? 0)) {
					next[room.id] = newest;
					changed = true;
				}
			}
		}
		if (changed) lastSeenAt = next;
	});

	const unreadCounts = $derived.by<Record<string, number>>(() => {
		const out: Record<string, number> = {};
		if (!chatQuery.data) return out;
		for (const room of chatQuery.data.rooms) {
			const seen = lastSeenAt[room.id] ?? 0;
			let count = 0;
			for (const m of room.messages ?? []) {
				if (toMs(m.createdAt) > seen) count++;
			}
			if (count > 0) out[room.id] = count;
		}
		return out;
	});
	const unreadRoomIds = $derived(new Set(Object.keys(unreadCounts)));

	function setMediaAutoload(v: MediaAutoload) {
		mediaAutoload = v;
		window.localStorage.setItem('chat:mediaAutoload', v);
	}

	setContext('mediaAutoload', () => mediaAutoload);
	setContext('myAliases', () => myAliases);
	setContext('knownUserIds', () => knownUserIds);
	// Admin clear-chat goes through /api/admin/clear-room which bypasses perms.
	setContext('isAdmin', () => isAdmin);
	setContext('clearRoomViaAdmin', async (roomId: string) => {
		const res = await adminFetch('/api/admin/clear-room', { roomId });
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body.error ?? res.statusText);
		}
	});

	function setAccent(a: Accent) {
		accent = a;
		window.localStorage.setItem('chat:accent', a);
		document.documentElement.setAttribute('data-accent', a);
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		document.documentElement.setAttribute('data-accent', accent);
	});

	function applyTheme(t: Theme) {
		const isDark =
			t === 'dark' ||
			(t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
		document.documentElement.classList.toggle('dark', isDark);
	}

	function setTheme(t: Theme) {
		theme = t;
		window.localStorage.setItem('chat:theme', t);
		applyTheme(t);
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		applyTheme(theme);
		if (theme !== 'system') return;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => applyTheme('system');
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	function openPrefs() {
		profileNameInput = nickname;
		prefsOpen = true;
	}

	function closePrefs() {
		prefsOpen = false;
	}

	async function saveProfile() {
		const trimmed = profileNameInput.trim();
		if (!trimmed || trimmed === nickname || !auth.user) return;
		await persistNickname(trimmed);
	}

	async function saveNickname() {
		const trimmed = nicknameInput.trim();
		if (!trimmed || !auth.user) return;
		await persistNickname(trimmed);
		nicknameInput = '';
	}

	async function persistNickname(newNick: string) {
		if (!auth.user) return;
		if (myProfile) {
			await db.transact(db.tx.profiles[myProfile.id].update({ nickname: newNick }));
		} else {
			const profileId = id();
			await db.transact(
				db.tx.profiles[profileId]
					.update({ nickname: newNick, userId: auth.user.id, createdAt: Date.now() })
					.link({ user: auth.user.id })
			);
		}
	}

	const chatQuery = db.useQuery(() => ({
		rooms: {
			messages: {
				replyTo: { media: {} },
				media: {},
				$: { order: { createdAt: 'asc' } }
			},
			// Members are profiles — nickname + userId are right on them.
			members: {}
		}
	}));

	const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'webm', 'mp4'] as const;
	const ALLOWED_ACCEPT = '.png,.jpg,.jpeg,.jfif,.webp,.gif,.webm,.mp4,image/*,video/*';
	const MAX_BYTES = 25 * 1024 * 1024; // 25 MB (Cloudinary free allows 100 MB)

	const CLOUDINARY_CLOUD = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string;
	const CLOUDINARY_PRESET = import.meta.env.VITE_CLOUDINARY_PRESET as string;

	function fileExt(path: string | undefined): string {
		if (!path) return '';
		const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
		return m ? m[1] : '';
	}

	function isVideoExt(ext: string): boolean {
		return ext === 'mp4' || ext === 'webm';
	}

	function inferContentType(ext: string): string {
		switch (ext) {
			case 'png':
				return 'image/png';
			case 'jpg':
			case 'jpeg':
			case 'jfif':
				return 'image/jpeg';
			case 'webp':
				return 'image/webp';
			case 'gif':
				return 'image/gif';
			case 'webm':
				return 'video/webm';
			case 'mp4':
				return 'video/mp4';
			default:
				return 'application/octet-stream';
		}
	}

	type Msg = NonNullable<typeof chatQuery.data>['rooms'][number]['messages'][number];

	function replyParent(msg: Msg): Msg | null {
		const r = msg.replyTo as Msg | Msg[] | null | undefined;
		if (!r) return null;
		if (Array.isArray(r)) return r[0] ?? null;
		return r;
	}

	type Attachment = NonNullable<Msg['media']>[number];

	function firstAttachment(msg: Msg | null | undefined): Attachment | null {
		if (!msg?.media?.length) return null;
		return msg.media[0] as Attachment;
	}

	function attachmentIsVideo(att: Attachment): boolean {
		if (att.resourceType === 'video') return true;
		if (att.resourceType === 'image') return false;
		return isVideoExt(fileExt(att.url));
	}

	function attachmentLabel(att: Attachment): string {
		return attachmentIsVideo(att) ? 'Video' : 'Image';
	}

	const activeRoom = $derived(chatQuery.data?.rooms.find((r) => r.id === activeRoomId));
	const activeMessages = $derived(activeRoom?.messages ?? []);

	const lobby = db.room('lobby', 'global');
	const presence = db.rooms.usePresence(lobby);

	const auth = db.useAuth();

	// User's profile (nickname snapshot lives here). Indexed by the
	// denormalized userId field so the query doesn't need to traverse to
	// $users (which is locked down to self-only).
	const NO_USER_ID = '00000000-0000-0000-0000-000000000000';
	const myProfileQuery = db.useQuery(() => ({
		profiles: {
			$: { where: { userId: auth.user?.id ?? NO_USER_ID } }
		}
	}));
	const myProfile = $derived(myProfileQuery.data?.profiles?.[0] ?? null);
	const userId = $derived(auth.user?.id ?? '');
	const nickname = $derived((myProfile?.nickname ?? '').trim());
	// Aliases for legacy DM rooms whose name still encodes nicknames. New DMs
	// use participants links and don't need this, but old data does.
	const myAliases = $derived<string[]>(nickname ? [nickname] : []);

	// Signin form state.
	let signinEmail = $state('');
	let signinCode = $state('');
	let signinSentCode = $state(false);
	let signinLoading = $state(false);
	let signinError: string | null = $state(null);

	async function sendSigninCode() {
		const email = signinEmail.trim();
		if (!email) return;
		signinLoading = true;
		signinError = null;
		try {
			await db.auth.sendMagicCode({ email });
			signinSentCode = true;
		} catch (err) {
			signinError = err instanceof Error ? err.message : String(err);
		} finally {
			signinLoading = false;
		}
	}

	async function verifySigninCode() {
		const email = signinEmail.trim();
		const code = signinCode.trim();
		if (!email || !code) return;
		signinLoading = true;
		signinError = null;
		try {
			await db.auth.signInWithMagicCode({ email, code });
			signinSentCode = false;
			signinCode = '';
			signinEmail = '';
		} catch (err) {
			signinError = err instanceof Error ? err.message : String(err);
		} finally {
			signinLoading = false;
		}
	}

	async function continueAsGuest() {
		signinLoading = true;
		signinError = null;
		try {
			await db.auth.signInAsGuest();
		} catch (err) {
			signinError = err instanceof Error ? err.message : String(err);
		} finally {
			signinLoading = false;
		}
	}

	function resetSigninForm() {
		signinSentCode = false;
		signinCode = '';
	}

	async function signOut() {
		try {
			await db.auth.signOut();
		} catch (err) {
			console.warn('Sign-out failed', err);
		}
	}

	// Admin flag — server checks the caller's email against ADMIN_EMAILS env.
	// Refetched whenever the auth user changes (signin/upgrade/signout).
	let isAdmin = $state(false);
	$effect(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const token = (auth.user as any)?.refresh_token as string | undefined;
		if (!token) {
			isAdmin = false;
			return;
		}
		fetch('/api/me', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
			.then((r) => (r.ok ? r.json() : { isAdmin: false }))
			.then((body) => (isAdmin = !!body.isAdmin))
			.catch(() => (isAdmin = false));
	});

	// Helper: client side fetch with the caller's bearer token, used for the
	// admin-only mutation endpoints.
	async function adminFetch(path: string, body?: unknown): Promise<Response> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const token = (auth.user as any)?.refresh_token as string | undefined;
		return fetch(path, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			body: body ? JSON.stringify(body) : undefined
		});
	}

	// Guest → email upgrade flow. Inside the preferences dialog; only shown
	// when auth.user.type === 'guest'. signInWithMagicCode passes the guest's
	// refresh_token to the server, which upgrades the same $users.id — so
	// profile, messages, DMs all stay linked to "us".
	let upgradeEmail = $state('');
	let upgradeCode = $state('');
	let upgradeSentCode = $state(false);
	let upgradeLoading = $state(false);
	let upgradeError: string | null = $state(null);

	async function sendUpgradeCode() {
		const email = upgradeEmail.trim();
		if (!email) return;
		upgradeLoading = true;
		upgradeError = null;
		try {
			await db.auth.sendMagicCode({ email });
			upgradeSentCode = true;
		} catch (err) {
			upgradeError = err instanceof Error ? err.message : String(err);
		} finally {
			upgradeLoading = false;
		}
	}

	async function verifyUpgradeCode() {
		const email = upgradeEmail.trim();
		const code = upgradeCode.trim();
		if (!email || !code) return;
		upgradeLoading = true;
		upgradeError = null;
		try {
			await db.auth.signInWithMagicCode({ email, code });
			upgradeSentCode = false;
			upgradeCode = '';
			upgradeEmail = '';
		} catch (err) {
			upgradeError = err instanceof Error ? err.message : String(err);
		} finally {
			upgradeLoading = false;
		}
	}

	let deleteAccountLoading = $state(false);

	async function deleteAccount() {
		const ok = await confirmDialog({
			title: 'Delete your account?',
			body: 'This permanently removes your account and profile. Your messages stay in others\' chats but show as a deleted user. This can\'t be undone.',
			confirmLabel: 'Delete account',
			destructive: true
		});
		if (!ok) return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const token = (auth.user as any)?.refresh_token as string | undefined;
		if (!token) {
			await confirmDialog({
				title: 'Could not delete',
				body: "We couldn't find your auth token. Sign out and back in, then try again.",
				confirmLabel: 'OK',
				hideCancel: true
			});
			return;
		}
		deleteAccountLoading = true;
		try {
			const res = await fetch('/api/delete-account', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` }
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				await confirmDialog({
					title: 'Delete failed',
					body: body.error ?? res.statusText,
					confirmLabel: 'OK',
					cancelLabel: ''
				});
				return;
			}
			closePrefs();
			await db.auth.signOut();
		} catch (err) {
			await confirmDialog({
				title: 'Delete failed',
				body: err instanceof Error ? err.message : String(err),
				confirmLabel: 'OK',
				hideCancel: true
			});
		} finally {
			deleteAccountLoading = false;
		}
	}

	$effect(() => {
		if (nickname && userId) {
			presence.publishPresence({
				nickname,
				userId,
				currentRoomId: activeRoomId ?? undefined
			});
		}
	});

	type OnlineUser = {
		key: string;
		userId: string;
		nickname: string;
		currentRoomId: string | null;
		isSelf: boolean;
	};

	const peerUsers = $derived(
		Object.entries(presence.peers ?? {}).map(([peerId, p]) => {
			const peer = p as { nickname?: string; userId?: string; currentRoomId?: string | null };
			return {
				key: peerId,
				userId: peer.userId ?? peerId,
				nickname: peer.nickname ?? 'Anonymous',
				currentRoomId: peer.currentRoomId ?? null,
				isSelf: false
			} satisfies OnlineUser;
		})
	);

	const onlineUsers = $derived<OnlineUser[]>(
		nickname && userId
			? [
					{
						key: 'self',
						userId,
						nickname,
						currentRoomId: activeRoomId,
						isSelf: true
					},
					...peerUsers
				]
			: peerUsers
	);

	let sidebarTab: 'all' | 'room' = $state('all');
	let userFilter = $state('');

	const onlineNicknames = $derived(new Set(onlineUsers.map((u) => u.nickname)));
	const onlineUserIds = $derived(new Set(onlineUsers.map((u) => u.userId)));

	// Most-recent message timestamp per author. Used by the profile dialog to
	// show "Last seen X ago". Keyed by both authorId (for new messages) and
	// author nickname (for legacy messages with no authorId).
	const lastMessageByAuthor = $derived.by<{ byId: Map<string, number>; byNickname: Map<string, number> }>(() => {
		const byId = new Map<string, number>();
		const byNickname = new Map<string, number>();
		for (const room of chatQuery.data?.rooms ?? []) {
			for (const m of room.messages ?? []) {
				const ts = toMs(m.createdAt);
				const authorId = (m as { authorId?: string | null }).authorId;
				if (authorId) {
					const prev = byId.get(authorId) ?? 0;
					if (ts > prev) byId.set(authorId, ts);
				}
				if (m.author) {
					const prev = byNickname.get(m.author) ?? 0;
					if (ts > prev) byNickname.set(m.author, ts);
				}
			}
		}
		return { byId, byNickname };
	});

	function formatLastSeen(ms: number | null): string {
		if (ms == null) return "Hasn't posted yet.";
		const diff = Date.now() - ms;
		if (diff < 60_000) return 'Last seen just now.';
		if (diff < 60 * 60_000) {
			const mins = Math.round(diff / 60_000);
			return `Last seen ${mins} minute${mins === 1 ? '' : 's'} ago.`;
		}
		if (diff < 24 * 60 * 60_000) {
			const hrs = Math.round(diff / (60 * 60_000));
			return `Last seen ${hrs} hour${hrs === 1 ? '' : 's'} ago.`;
		}
		if (diff < 7 * 24 * 60 * 60_000) {
			const days = Math.round(diff / (24 * 60 * 60_000));
			return `Last seen ${days} day${days === 1 ? '' : 's'} ago.`;
		}
		const d = new Date(ms);
		const dd = String(d.getDate()).padStart(2, '0');
		const mm = String(d.getMonth() + 1).padStart(2, '0');
		return `Last seen on ${dd}/${mm}/${d.getFullYear()}.`;
	}

	// All known users (anyone who has a profile). Profiles are public; the
	// `userId` field is denormalized so we don't have to traverse to $users
	// (which is locked to self-only view to keep emails private).
	const allProfilesQuery = db.useQuery(() => ({ profiles: {} }));
	// Set of currently-existing user IDs — sourced from profiles, so anyone
	// with a profile is "known", and anyone with a message authorId not in
	// this set is considered deleted in the UI.
	const knownUserIds = $derived(
		new Set(
			(allProfilesQuery.data?.profiles ?? [])
				.map((p) => p.userId)
				.filter((id): id is string => !!id)
		)
	);
	type OfflineEntry = { nickname: string; userId: string | null };
	const offlineAll = $derived<OfflineEntry[]>(
		(allProfilesQuery.data?.profiles ?? [])
			.map((p) => ({ nickname: p.nickname, userId: p.userId ?? null }))
			.filter((p) => p.nickname && p.userId && !onlineUserIds.has(p.userId))
			.sort((a, b) => a.nickname.localeCompare(b.nickname))
	);

	// DM participants resolved into rich {userId, nickname} entries. Built from
	// (1) the participants link, then (2) any message author the link missed —
	// covers the case where a participant's $users was deleted and the link
	// record was reaped with it. Nicknames fall back to message snapshots so
	// the room user list never shows a raw UUID.
	type DmParticipantInfo = { userId: string; nickname: string };
	const dmParticipantsInfo = $derived.by<DmParticipantInfo[]>(() => {
		if (!activeRoom || activeRoom.kind !== 'dm') return [];
		const msgs = activeRoom.messages ?? [];
		const resolveNick = (uid: string, profileNick: string | null | undefined): string => {
			if (profileNick) return profileNick;
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i];
				if (m.authorId === uid && m.author) return m.author;
			}
			return 'Deleted user';
		};
		const out: DmParticipantInfo[] = [];
		const seen = new Set<string>();
		for (const p of activeRoom.members ?? []) {
			if (!p.userId || seen.has(p.userId)) continue;
			seen.add(p.userId);
			out.push({ userId: p.userId, nickname: resolveNick(p.userId, p.nickname) });
		}
		for (const m of msgs) {
			if (!m.authorId || seen.has(m.authorId)) continue;
			seen.add(m.authorId);
			out.push({ userId: m.authorId, nickname: resolveNick(m.authorId, null) });
		}
		return out;
	});

	const onlineInRoom = $derived(
		activeRoom?.kind === 'dm'
			? onlineUsers.filter((u) =>
					dmParticipantsInfo.some((p) => p.userId === u.userId)
				)
			: onlineUsers.filter((u) => u.currentRoomId === activeRoomId)
	);
	// All users who've posted in the active room. Keyed by authorId so we can
	// route through the deletion check; legacy messages with no authorId still
	// show by nickname-only (userId stays null).
	const roomAuthorsRich = $derived.by<OfflineEntry[]>(() => {
		const byId = new Map<string, string>();
		const noIdNicks = new Set<string>();
		for (const m of activeRoom?.messages ?? []) {
			if (m.authorId) byId.set(m.authorId, m.author);
			else if (m.author) noIdNicks.add(m.author);
		}
		const out: OfflineEntry[] = [];
		for (const [userId, nickname] of byId) out.push({ userId, nickname });
		for (const nickname of noIdNicks) {
			if (out.some((a) => a.nickname === nickname)) continue;
			out.push({ userId: null, nickname });
		}
		return out;
	});
	const offlineInRoom = $derived<OfflineEntry[]>(
		activeRoom?.kind === 'dm'
			? dmParticipantsInfo
					.filter((p) => !onlineUserIds.has(p.userId))
					.sort((a, b) => a.nickname.localeCompare(b.nickname))
			: roomAuthorsRich
					.filter((a) =>
						a.userId ? !onlineUserIds.has(a.userId) : !onlineNicknames.has(a.nickname)
					)
					.sort((a, b) => a.nickname.localeCompare(b.nickname))
	);

	const tabOnlineSource = $derived(sidebarTab === 'all' ? onlineUsers : onlineInRoom);
	const tabOfflineSource = $derived(sidebarTab === 'all' ? offlineAll : offlineInRoom);

	const filterQuery = $derived(userFilter.trim().toLowerCase());
	const tabOnline = $derived(
		filterQuery
			? tabOnlineSource.filter((u) => u.nickname.toLowerCase().includes(filterQuery))
			: tabOnlineSource
	);
	const tabOffline = $derived(
		filterQuery
			? tabOfflineSource.filter((e) => e.nickname.toLowerCase().includes(filterQuery))
			: tabOfflineSource
	);

	function roomName(roomId: string | null): string | null {
		if (!roomId) return null;
		const r = chatQuery.data?.rooms.find((rm) => rm.id === roomId);
		if (!r) return null;
		return roomDisplayName(r, nickname);
	}

	const sidebarRooms = $derived(
		(chatQuery.data?.rooms ?? [])
			.filter((r) => r.kind !== 'dm' && !isHidden(r.id))
			.sort((a, b) => a.name.localeCompare(b.name))
	);
	// Hide DMs that have no messages yet, unless the user is currently viewing
	// the DM in some pane (so opening a fresh DM doesn't make it vanish from
	// the sidebar while you're composing the first message). Sorted by most
	// recent activity at the top — latest message timestamp, falling back to
	// room creation time for brand-new DMs. ALSO filtered to DMs the current
	// user is actually a participant in — without this you'd see every DM in
	// the database. (Server-side perms in instant.perms.ts also enforce this.)
	const sidebarDms = $derived(
		(chatQuery.data?.rooms ?? [])
			.filter((r) => {
				if (r.kind !== 'dm' || isHidden(r.id)) return false;
				if (!userId) return false;
				const iAmMember = (r.members ?? []).some((p) => p.userId === userId);
				if (!iAmMember) return false;
				const hasMessages = (r.messages?.length ?? 0) > 0;
				const isOpen = panes.some((p) => p.roomId === r.id);
				return hasMessages || isOpen;
			})
			.sort((a, b) => dmLastActivityMs(b) - dmLastActivityMs(a))
	);

	function dmLastActivityMs(room: { messages?: { createdAt: number | string | Date }[]; createdAt: number | string | Date }): number {
		let latest = 0;
		for (const m of room.messages ?? []) {
			const ts = toMs(m.createdAt);
			if (ts > latest) latest = ts;
		}
		return latest || toMs(room.createdAt);
	}

	async function openDmWith(other: { userId: string; nickname: string }) {
		if (!auth.user || !other.userId || other.userId === auth.user.id) return;
		const key = dmKeyFor(auth.user.id, other.userId);
		const existing = chatQuery.data?.rooms.find((r) => r.kind === 'dm' && r.name === key);
		if (existing) {
			selectRoom(existing.id);
			return;
		}
		// Participants link targets profiles now — need both profile IDs.
		const myProfileId = myProfile?.id;
		const otherProfile = (allProfilesQuery.data?.profiles ?? []).find(
			(p) => p.userId === other.userId
		);
		if (!myProfileId || !otherProfile) {
			console.warn('[openDmWith] missing profile id', {
				me: !!myProfileId,
				other: !!otherProfile
			});
			return;
		}
		const roomId = id();
		try {
			await db.transact(
				db.tx.rooms[roomId]
					.update({
						name: key,
						kind: 'dm',
						createdAt: Date.now(),
						createdBy: nickname,
						createdById: auth.user.id
					})
					.link({ members: [myProfileId, otherProfile.id] })
			);
			selectRoom(roomId);
		} catch (err) {
			// Race: the DM already exists (other side created it, or our previous
			// click hadn't synced yet). Wait briefly for chatQuery to catch up
			// and select the existing room by its dedup key.
			const msg = err instanceof Error ? err.message : String(err);
			if (!/rooms\.name|record-not-unique|already exists/i.test(msg)) {
				console.error('[openDmWith] transact failed:', err);
				return;
			}
			for (let i = 0; i < 20; i++) {
				const found = chatQuery.data?.rooms.find((r) => r.kind === 'dm' && r.name === key);
				if (found) {
					selectRoom(found.id);
					return;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			console.warn('[openDmWith] DM existed but never appeared in chatQuery');
		}
	}

	function createRoom() {
		const name = newRoomName.trim();
		if (!name || !auth.user) return;
		const roomId = id();
		db.transact(
			db.tx.rooms[roomId].update({
				name,
				createdAt: Date.now(),
				createdBy: nickname,
				createdById: auth.user.id
			})
		);
		newRoomName = '';
		selectRoom(roomId);
	}

	function selectRoom(roomId: string) {
		panes = panes.map((p) => (p.id === focusedPaneId ? { ...p, roomId } : p));
		unhideRoom(roomId);
		markRead(roomId);
	}



	type ProfileView = {
		userId: string | null;
		nickname: string;
		isOnline: boolean;
		currentRoomId: string | null;
		isSelf: boolean;
	};
	let profile: ProfileView | null = $state(null);

	function openProfile(p: ProfileView) {
		profile = p;
	}

	function closeProfile() {
		profile = null;
	}

	function gotoProfileRoom() {
		if (profile?.currentRoomId) {
			selectRoom(profile.currentRoomId);
			closeProfile();
		}
	}

	type LightboxMedia = {
		id: string;
		src: string;
		type: 'image' | 'video';
		width?: number;
		height?: number;
		alt?: string;
	};
	let lightbox: LightboxMedia | null = $state(null);

	const galleryMedia = $derived<LightboxMedia[]>(
		activeMessages.flatMap((m) =>
			(m.media ?? [])
				.filter((att) => !!att.url)
				.map((att) => ({
					id: att.id,
					src: att.url,
					type: (attachmentIsVideo(att) ? 'video' : 'image') as 'image' | 'video',
					width: att.width ?? undefined,
					height: att.height ?? undefined,
					alt: att.url
				}))
		)
	);

	const lightboxIndex = $derived(
		lightbox ? galleryMedia.findIndex((m) => m.id === lightbox?.id) : -1
	);
	const hasPrev = $derived(lightboxIndex > 0);
	const hasNext = $derived(lightboxIndex >= 0 && lightboxIndex < galleryMedia.length - 1);

	function openLightbox(m: LightboxMedia) {
		lightbox = m;
	}

	function closeLightbox() {
		lightbox = null;
	}

	function prevLightbox() {
		if (hasPrev) lightbox = galleryMedia[lightboxIndex - 1];
	}

	function nextLightbox() {
		if (hasNext) lightbox = galleryMedia[lightboxIndex + 1];
	}

	let lastWheelAt = 0;
	function lightboxWheel(e: WheelEvent) {
		if (!lightbox) return;
		const now = performance.now();
		if (now - lastWheelAt < 250) return;
		const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
		if (Math.abs(delta) < 12) return;
		lastWheelAt = now;
		if (delta > 0) nextLightbox();
		else prevLightbox();
	}

	function downloadUrl(src: string): string {
		return src.replace('/upload/', '/upload/fl_attachment/');
	}

	function filenameFromUrl(url: string): string {
		try {
			const path = new URL(url).pathname;
			return path.split('/').pop() || 'download';
		} catch {
			return 'download';
		}
	}

	async function downloadMedia(src: string) {
		try {
			const res = await fetch(downloadUrl(src));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const blobUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = blobUrl;
			a.download = filenameFromUrl(src);
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
		} catch (err) {
			console.error('Download failed', err);
		}
	}

	setContext('openLightbox', (m: LightboxMedia) => openLightbox(m));
	setContext('openProfile', (p: ProfileView) => openProfile(p));
	setContext('authorPresence', (author: string) => {
		const online = onlineUsers.find((u) => u.nickname === author);
		return online
			? { userId: online.userId, isOnline: true, currentRoomId: online.currentRoomId }
			: { userId: null, isOnline: false, currentRoomId: null };
	});









	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (roomContextMenu) closeRoomContextMenu();
				else if (lightbox) closeLightbox();
				else if (profile) closeProfile();
				else if (prefsOpen) closePrefs();
				return;
			}
			if (lightbox) {
				if (e.key === 'ArrowLeft') {
					e.preventDefault();
					prevLightbox();
				} else if (e.key === 'ArrowRight') {
					e.preventDefault();
					nextLightbox();
				}
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
				e.preventDefault();
				debugOpen = !debugOpen;
			}
		};
		const onDocClick = () => {
			if (roomContextMenu) closeRoomContextMenu();
		};
		const onVisChange = () => {
			tabVisible = document.visibilityState === 'visible';
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('click', onDocClick);
		document.addEventListener('visibilitychange', onVisChange);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('click', onDocClick);
			document.removeEventListener('visibilitychange', onVisChange);
		};
	});





</script>

{#if auth.isLoading || myProfileQuery.isLoading}
	<div class="flex min-h-screen items-center justify-center bg-neutral-100 p-4 dark:bg-neutral-950">
		<div class="text-sm text-neutral-500 dark:text-neutral-400">Loading…</div>
	</div>
{:else if !auth.user}
	<div class="flex min-h-screen items-center justify-center bg-neutral-100 p-4 dark:bg-neutral-950">
		<div class="w-full max-w-sm rounded-2xl bg-white p-6 shadow dark:bg-neutral-900 dark:shadow-neutral-950/50">
			<h1 class="mb-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Sign in</h1>
			<p class="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
				{signinSentCode
					? `Enter the 6-digit code we sent to ${signinEmail}.`
					: 'We’ll send you a magic code.'}
			</p>
			{#if !signinSentCode}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						sendSigninCode();
					}}
					class="space-y-3"
				>
					<input
						bind:value={signinEmail}
						type="email"
						autocomplete="email"
						required
						placeholder="you@example.com"
						class="block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
					/>
					<button
						type="submit"
						disabled={signinLoading || !signinEmail.trim()}
						class="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-accent-500 dark:hover:bg-accent-400"
					>
						<LogIn size={16} />
						{signinLoading ? 'Sending…' : 'Send magic code'}
					</button>
				</form>
			{:else}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						verifySigninCode();
					}}
					class="space-y-3"
				>
					<input
						bind:value={signinCode}
						inputmode="numeric"
						autocomplete="one-time-code"
						required
						placeholder="123456"
						class="block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm tracking-widest text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
					/>
					<button
						type="submit"
						disabled={signinLoading || !signinCode.trim()}
						class="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-accent-500 dark:hover:bg-accent-400"
					>
						{signinLoading ? 'Verifying…' : 'Verify'}
					</button>
					<button
						type="button"
						onclick={resetSigninForm}
						class="block w-full text-center text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
					>
						Use a different email
					</button>
				</form>
			{/if}
			{#if signinError}
				<div class="mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
					{signinError}
				</div>
			{/if}
			<div class="my-4 flex items-center gap-2 text-xs text-neutral-400 dark:text-neutral-500">
				<span class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800"></span>
				<span>or</span>
				<span class="h-px flex-1 bg-neutral-200 dark:bg-neutral-800"></span>
			</div>
			<button
				type="button"
				onclick={continueAsGuest}
				disabled={signinLoading}
				class="block w-full rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
			>
				Continue as guest
			</button>
		</div>
	</div>
{:else if !nickname}
	<div class="flex min-h-screen items-center justify-center bg-neutral-100 p-4 dark:bg-neutral-950">
		<div class="w-full max-w-sm rounded-2xl bg-white p-6 shadow dark:bg-neutral-900 dark:shadow-neutral-950/50">
			<h1 class="mb-1 text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Pick a nickname</h1>
			<p class="mb-4 text-sm text-neutral-500 dark:text-neutral-400">
				This is what other people see in chats. You can change it later in preferences.
			</p>
			<form
				onsubmit={(e) => {
					e.preventDefault();
					saveNickname();
				}}
				class="flex gap-2"
			>
				<input
					bind:value={nicknameInput}
					placeholder="Your nickname"
					required
					class="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
				/>
				<button
					type="submit"
					disabled={!nicknameInput.trim()}
					class="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-accent-500 dark:hover:bg-accent-400"
				>
					<LogIn size={16} />
					Enter
				</button>
			</form>
			<button
				type="button"
				onclick={signOut}
				class="mt-4 block w-full text-center text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
			>
				Sign out
			</button>
		</div>
	</div>
{:else}
	<div class="flex h-screen gap-3 bg-neutral-100 p-3 dark:bg-neutral-950">
		<aside class="flex w-64 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-white/10 dark:bg-neutral-900">
			<button
				type="button"
				onclick={openPrefs}
				aria-label="Open preferences"
				class="group/userbtn flex items-center gap-2.5 border-b border-neutral-200 px-3 py-3 text-left hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/60"
			>
				<div
					class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white {avatarColor(
						nickname
					)}"
					aria-hidden="true"
				>
					{initials(nickname)}
				</div>
				<div class="flex-1 truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
					{nickname}
				</div>
				<Settings
					size={16}
					class="shrink-0 text-neutral-400 group-hover/userbtn:text-neutral-700 dark:text-neutral-500 dark:group-hover/userbtn:text-neutral-200"
				/>
			</button>

			<div class="p-3">
				<form
					onsubmit={(e) => {
						e.preventDefault();
						createRoom();
					}}
					class="flex gap-2"
				>
					<input
						bind:value={newRoomName}
						placeholder="New room name"
						class="min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
					/>
					<button
						type="submit"
						class="flex shrink-0 items-center justify-center rounded-md bg-accent-600 px-2 py-1.5 text-white hover:bg-accent-700 dark:bg-accent-500 dark:hover:bg-accent-400"
						aria-label="Create room"
					>
						<Plus size={16} />
					</button>
				</form>
			</div>

			<div class="flex-1 overflow-y-auto pb-3">
				{#if chatQuery.error}
					<div class="px-4 py-1 text-xs text-rose-600 dark:text-rose-400">
						Error: {chatQuery.error.message}
					</div>
				{:else if !chatQuery.data}
					<div class="px-4 py-1 text-xs text-neutral-400 dark:text-neutral-500">Loading…</div>
				{:else}
					<div class="mb-1 px-4 pt-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
						Rooms
					</div>
					{#if !sidebarRooms.length}
						<div class="px-4 py-1 text-xs text-neutral-400 dark:text-neutral-500">
							No rooms yet — create one above.
						</div>
					{:else}
						<ul class="mb-3">
							{#each sidebarRooms as room (room.id)}
								{@const isActive = activeRoomId === room.id}
								{@const isUnread = unreadRoomIds.has(room.id)}
								<li>
									<button
										type="button"
										onclick={() => selectRoom(room.id)}
										oncontextmenu={(e) => openRoomContextMenu(e, room.id, false)}
										class="block w-full truncate px-4 py-1.5 text-left text-sm {isActive
											? 'bg-accent-100 font-medium text-accent-700 dark:bg-accent-500/20 dark:text-accent-300'
											: isUnread
												? 'font-semibold text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800'
												: 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}"
									>
										{room.name}
									</button>
								</li>
							{/each}
						</ul>
					{/if}

					<div class="mb-1 px-4 pt-1 text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
						Direct Messages
					</div>
					{#if !sidebarDms.length}
						<div class="px-4 py-1 text-xs text-neutral-400 dark:text-neutral-500">
							No DMs yet — open someone's profile to start one.
						</div>
					{:else}
						<ul>
							{#each sidebarDms as room (room.id)}
								{@const other = dmOtherName(room, myAliases, userId)}
								{@const otherId = dmOtherUserId(room, userId)}
								{@const isActive = activeRoomId === room.id}
								{@const unread = unreadCounts[room.id] ?? 0}
								{@const isUnread = unread > 0}
								{@const isDeleted = !!otherId && !knownUserIds.has(otherId)}
								<li>
									<button
										type="button"
										onclick={() => selectRoom(room.id)}
										oncontextmenu={(e) => openRoomContextMenu(e, room.id, true)}
										class="flex w-full items-center gap-2 truncate px-4 py-1.5 text-left text-sm {isActive
											? 'bg-accent-100 font-medium text-accent-700 dark:bg-accent-500/20 dark:text-accent-300'
											: isDeleted
												? 'text-neutral-500 opacity-60 hover:bg-neutral-100 hover:opacity-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
												: isUnread
													? 'font-semibold text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800'
													: 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}"
									>
										<Avatar
											nickname={other}
											userId={otherId}
											size={20}
											rounded="rounded"
											textSize="text-[9px]"
											grayscale={isDeleted}
										/>
										<span class="flex-1 truncate">{other}</span>
										{#if isUnread && !isActive}
											<span
												class="ml-auto flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-accent-500 px-1.5 text-[10px] font-semibold leading-none text-white dark:bg-accent-400 dark:text-neutral-900"
												aria-label="{unread} unread message{unread === 1 ? '' : 's'}"
											>
												{unread > 99 ? '99+' : unread}
											</span>
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</div>
		</aside>

		<div bind:clientWidth={paneRowWidth} class="flex min-w-0 flex-1 gap-3">
			{#each panes as pane (pane.id)}
				<ChatPane
					roomId={pane.roomId}
					rooms={chatQuery.data?.rooms ?? []}
					{nickname}
					{userId}
					isFocused={focusedPaneId === pane.id}
					showSplitButton
					splitDisabled={!canSplit}
					showCloseButton={panes.length > 1}
					splitActive={panes.length > 1}
					onFocus={() => focusPaneId(pane.id)}
					onToggleSplit={() => addPaneAfter(pane.id)}
					onClose={() => closePane(pane.id)}
				/>
			{/each}
		</div>

		<aside class="flex w-64 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-white/10 dark:bg-neutral-900">
			<div class="flex border-b border-neutral-200 dark:border-neutral-800" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={sidebarTab === 'all'}
					onclick={() => (sidebarTab = 'all')}
					class="flex-1 border-b-2 px-3 py-3 text-sm font-medium transition-colors {sidebarTab ===
					'all'
						? 'border-accent-600 text-accent-700 dark:border-accent-400 dark:text-accent-300'
						: 'border-transparent text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'}"
				>
					All users
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={sidebarTab === 'room'}
					onclick={() => (sidebarTab = 'room')}
					class="flex-1 border-b-2 px-3 py-3 text-sm font-medium transition-colors {sidebarTab ===
					'room'
						? 'border-accent-600 text-accent-700 dark:border-accent-400 dark:text-accent-300'
						: 'border-transparent text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'}"
				>
					Room
				</button>
			</div>

			<div class="border-b border-neutral-200 p-3 dark:border-neutral-800">
				<div class="relative">
					<input
						bind:value={userFilter}
						placeholder="Filter users…"
						class="w-full min-w-0 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 pr-7 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
					/>
					{#if userFilter}
						<button
							type="button"
							onclick={() => (userFilter = '')}
							aria-label="Clear filter"
							class="absolute top-1/2 right-1.5 -tranneutral-y-1/2 flex items-center justify-center rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
						>
							<X size={14} />
						</button>
					{/if}
				</div>
			</div>

			<div class="flex-1 overflow-y-auto py-2">
				{#if sidebarTab === 'room' && !activeRoomId}
					<div class="px-4 py-1 text-xs text-neutral-400 dark:text-neutral-500">No room selected</div>
				{:else if !tabOnline.length && !tabOffline.length}
					<div class="px-4 py-1 text-xs text-neutral-400 dark:text-neutral-500">No one</div>
				{:else}
					<ul>
						{#each tabOnline as u (u.key)}
							{@const isHere = u.currentRoomId === activeRoomId}
							{@const rname = roomName(u.currentRoomId)}
							<li>
								<button
									type="button"
									onclick={() =>
										openProfile({
											userId: u.userId,
											nickname: u.nickname,
											isOnline: true,
											currentRoomId: u.currentRoomId,
											isSelf: u.isSelf
										})}
									class="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
								>
									<div
										class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white {avatarColor(
											u.nickname
										)}"
										aria-hidden="true"
									>
										{initials(u.nickname)}
									</div>
									<span class="flex-1 truncate">
										{u.nickname}{u.isSelf ? ' (you)' : ''}
									</span>
									{#if sidebarTab === 'all' && rname && !isHere}
										<span class="shrink-0 truncate text-xs text-neutral-400 dark:text-neutral-500">
											{rname}
										</span>
									{/if}
								</button>
							</li>
						{/each}
						{#each tabOffline as entry (entry.userId ?? entry.nickname)}
							<li>
								<button
									type="button"
									onclick={() =>
										openProfile({
											userId: entry.userId,
											nickname: entry.nickname,
											isOnline: false,
											currentRoomId: null,
											isSelf: entry.nickname === nickname
										})}
									class="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-neutral-500 opacity-60 hover:bg-neutral-100 hover:opacity-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
								>
									<Avatar
										nickname={entry.nickname}
										userId={entry.userId}
										size={28}
										rounded="rounded-md"
										textSize="text-xs"
										grayscale
									/>
									<span class="truncate">{entry.nickname}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</aside>
	</div>

	{#if prefsOpen}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			role="presentation"
			class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
			onclick={closePrefs}
		>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div
				role="dialog"
				tabindex="-1"
				aria-modal="true"
				aria-label="Preferences"
				onclick={(e) => e.stopPropagation()}
				class="flex h-[600px] max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-black/5 bg-white shadow-xl dark:border-white/10 dark:bg-neutral-900"
			>
				<header class="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
					<h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Preferences</h2>
					<button
						type="button"
						onclick={closePrefs}
						aria-label="Close preferences"
						class="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
					>
						<X size={18} />
					</button>
				</header>
				<div class="flex flex-1 overflow-hidden">
					<nav class="w-48 shrink-0 border-r border-neutral-200 p-2 dark:border-neutral-800">
						<ul class="space-y-0.5">
							<li>
								<button
									type="button"
									onclick={() => (prefsTab = 'profile')}
									class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors {prefsTab ===
									'profile'
										? 'bg-accent-100 font-medium text-accent-700 dark:bg-accent-500/20 dark:text-accent-300'
										: 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}"
								>
									<User size={14} />
									Profile
								</button>
							</li>
							<li>
								<button
									type="button"
									onclick={() => (prefsTab = 'appearance')}
									class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors {prefsTab ===
									'appearance'
										? 'bg-accent-100 font-medium text-accent-700 dark:bg-accent-500/20 dark:text-accent-300'
										: 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}"
								>
									<Palette size={14} />
									Appearance
								</button>
							</li>
						</ul>
					</nav>

					<div class="flex-1 overflow-y-auto p-6">
						{#if prefsTab === 'profile'}
							<h3 class="mb-1 text-base font-semibold text-neutral-900 dark:text-neutral-100">
								Profile
							</h3>
							<p class="mb-5 text-sm text-neutral-500 dark:text-neutral-400">
								Your nickname and avatar are shown to other people in chats.
							</p>
							<div class="mb-5 flex items-center gap-4">
								<div
									class="flex h-16 w-16 items-center justify-center rounded-lg text-xl font-semibold text-white {avatarColor(
										profileNameInput || nickname
									)}"
									aria-hidden="true"
								>
									{initials(profileNameInput || nickname)}
								</div>
								<div class="text-sm text-neutral-500 dark:text-neutral-400">
									Avatar color and initials are generated from your nickname.
								</div>
							</div>

							<label class="block">
								<span class="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
									Nickname
								</span>
								<input
									bind:value={profileNameInput}
									placeholder="Your nickname"
									class="block w-full max-w-sm rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
								/>
							</label>
							<div class="mt-4">
								<button
									type="button"
									onclick={saveProfile}
									disabled={!profileNameInput.trim() || profileNameInput.trim() === nickname}
									class="rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-accent-500 dark:hover:bg-accent-400"
								>
									Save changes
								</button>
							</div>

							{#if auth.user?.type === 'guest'}
								<div class="mt-8 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
									<h4 class="text-sm font-semibold text-amber-900 dark:text-amber-200">
										You're signed in as a guest
									</h4>
									<p class="mt-1 mb-3 text-xs text-amber-800 dark:text-amber-300/90">
										Add an email so you don't lose your account if your browser data is cleared. Your nickname, messages, and DMs will all stay yours.
									</p>
									{#if !upgradeSentCode}
										<form
											onsubmit={(e) => {
												e.preventDefault();
												sendUpgradeCode();
											}}
											class="flex gap-2"
										>
											<input
												bind:value={upgradeEmail}
												type="email"
												required
												placeholder="you@example.com"
												class="min-w-0 flex-1 rounded-md border border-amber-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-amber-500/30 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
											/>
											<button
												type="submit"
												disabled={upgradeLoading || !upgradeEmail.trim()}
												class="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-accent-500 dark:hover:bg-accent-400"
											>
												{upgradeLoading ? 'Sending…' : 'Send code'}
											</button>
										</form>
									{:else}
										<form
											onsubmit={(e) => {
												e.preventDefault();
												verifyUpgradeCode();
											}}
											class="flex gap-2"
										>
											<input
												bind:value={upgradeCode}
												inputmode="numeric"
												autocomplete="one-time-code"
												required
												placeholder="123456"
												class="min-w-0 flex-1 rounded-md border border-amber-200 bg-white px-2.5 py-1.5 text-sm tracking-widest text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-amber-500/30 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
											/>
											<button
												type="submit"
												disabled={upgradeLoading || !upgradeCode.trim()}
												class="shrink-0 rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-accent-500 dark:hover:bg-accent-400"
											>
												{upgradeLoading ? 'Verifying…' : 'Verify'}
											</button>
											<button
												type="button"
												onclick={() => {
													upgradeSentCode = false;
													upgradeCode = '';
												}}
												class="shrink-0 rounded-md px-2 py-1.5 text-xs text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20"
											>
												Use different email
											</button>
										</form>
									{/if}
									{#if upgradeError}
										<div class="mt-2 text-xs text-rose-600 dark:text-rose-400">{upgradeError}</div>
									{/if}
								</div>
							{/if}

							<div class="mt-10 border-t border-neutral-200 pt-6 dark:border-neutral-800">
								<h4 class="text-sm font-semibold text-rose-700 dark:text-rose-400">Danger zone</h4>
								<p class="mt-1 mb-3 text-xs text-neutral-500 dark:text-neutral-400">
									Deleting your account is permanent. Your messages will stay in others' chats but show as a deleted user.
								</p>
								<button
									type="button"
									onclick={deleteAccount}
									disabled={deleteAccountLoading}
									class="rounded-md border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
								>
									{deleteAccountLoading ? 'Deleting…' : 'Delete my account'}
								</button>
							</div>
						{:else if prefsTab === 'appearance'}
							<h3 class="mb-1 text-base font-semibold text-neutral-900 dark:text-neutral-100">
								Appearance
							</h3>
							<p class="mb-5 text-sm text-neutral-500 dark:text-neutral-400">
								Choose how the app looks. System will follow your operating system's setting.
							</p>

							<div class="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
								Colour mode
							</div>
							<div class="flex gap-2">
								{#each [{ value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'System', icon: Monitor }] as opt (opt.value)}
									{@const isActive = theme === opt.value}
									{@const Icon = opt.icon}
									<button
										type="button"
										onclick={() => setTheme(opt.value as Theme)}
										class="flex flex-1 items-center justify-center gap-2 rounded-lg border-2 px-4 py-3 text-sm font-medium transition-colors {isActive
											? 'border-accent-500 bg-accent-50 text-accent-700 dark:border-accent-400 dark:bg-accent-500/10 dark:text-accent-300'
											: 'border-neutral-200 text-neutral-700 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-600'}"
									>
										<Icon size={16} />
										{opt.label}
									</button>
								{/each}
							</div>

							<div class="mt-7 mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
								Auto-play media
							</div>
							<p class="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
								Choose what loads automatically. The rest will show a click-to-load preview.
							</p>
							<div class="mb-7 flex gap-2">
								{#each [{ value: 'all', label: 'All media' }, { value: 'images', label: 'Images only' }, { value: 'none', label: 'Click to load' }] as opt (opt.value)}
									{@const isActive = mediaAutoload === opt.value}
									<button
										type="button"
										onclick={() => setMediaAutoload(opt.value as MediaAutoload)}
										class="flex flex-1 items-center justify-center rounded-lg border-2 px-3 py-2.5 text-sm font-medium transition-colors {isActive
											? 'border-accent-500 bg-accent-50 text-accent-700 dark:border-accent-400 dark:bg-accent-500/10 dark:text-accent-300'
											: 'border-neutral-200 text-neutral-700 hover:border-neutral-300 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-600'}"
									>
										{opt.label}
									</button>
								{/each}
							</div>

							<div class="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
								Accent colour
							</div>
							<div class="grid grid-cols-3 gap-2">
								{#each ACCENTS as a (a.value)}
									{@const isActive = accent === a.value}
									<button
										type="button"
										onclick={() => setAccent(a.value)}
										class="flex items-center gap-2.5 rounded-lg border-2 px-3 py-2.5 text-left text-sm font-medium transition-colors {isActive
											? 'border-neutral-900 dark:border-neutral-100'
											: 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-700 dark:hover:border-neutral-600'}"
									>
										<span
											class="h-5 w-5 shrink-0 rounded-full"
											style="background-color: var({a.cssVar})"
											aria-hidden="true"
										></span>
										<span class="text-neutral-700 dark:text-neutral-200">{a.label}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	{/if}

	{#if debugOpen}
		<DebugHUD />
	{/if}

	{#if profile}
		{@const p = profile}
		{@const pRoomName = p.currentRoomId ? roomName(p.currentRoomId) : null}
		{@const pIsHere = p.currentRoomId === activeRoomId}
		{@const pIsDeleted = !!p.userId && !knownUserIds.has(p.userId)}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div
			role="presentation"
			class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
			onclick={closeProfile}
		>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div
				role="dialog"
				tabindex="-1"
				aria-modal="true"
				aria-label="Profile"
				onclick={(e) => e.stopPropagation()}
				class="w-full max-w-sm overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl dark:border-white/10 dark:bg-neutral-900"
			>
				<div class="flex items-center justify-end px-3 pt-3">
					<button
						type="button"
						onclick={closeProfile}
						aria-label="Close"
						class="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
					>
						<X size={18} />
					</button>
				</div>
				<div class="flex flex-col items-center px-6 pb-2">
					<Avatar
						nickname={p.nickname}
						userId={p.userId}
						size={96}
						rounded="rounded-2xl"
						textSize="text-3xl"
						grayscale={!p.isOnline && !pIsDeleted}
					/>
					<div class="mt-3 text-center text-xl font-semibold text-neutral-900 dark:text-neutral-100">
						{p.nickname}{p.isSelf ? ' (you)' : ''}
					</div>
					{#if pIsDeleted}
						<div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Deleted user</div>
					{:else}
						<div class="mt-1 flex items-center gap-1.5 text-xs">
							<span
								class="h-2 w-2 rounded-full {p.isOnline
									? 'bg-emerald-500'
									: 'bg-neutral-400 dark:bg-neutral-600'}"
							></span>
							<span class="text-neutral-500 dark:text-neutral-400">
								{p.isOnline ? 'Online' : 'Offline'}
							</span>
						</div>
					{/if}
				</div>
				<div class="space-y-4 px-6 pt-4 pb-6">
					{#if pIsDeleted}
						<div class="rounded-md bg-neutral-50 px-3 py-3 text-center text-sm text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
							This user no longer exists.
						</div>
					{:else if !p.isSelf && p.userId}
						<button
							type="button"
							onclick={() => {
								const target = { userId: p.userId!, nickname: p.nickname };
								closeProfile();
								openDmWith(target);
							}}
							class="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent-600 px-3 py-2 text-sm font-medium text-white hover:bg-accent-700 dark:bg-accent-500 dark:hover:bg-accent-400"
						>
							<MessageCircle size={14} />
							Message
						</button>
					{:else if !p.isSelf}
						<div class="rounded-md border border-dashed border-neutral-300 px-3 py-2 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
							Can't DM offline users yet — open this profile while they're online.
						</div>
					{/if}
					{#if pIsDeleted}
						<!-- Deletion notice above replaces the body for deleted users. -->
					{:else if p.isOnline && pRoomName}
						<div>
							<div class="text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
								Currently in
							</div>
							<button
								type="button"
								onclick={gotoProfileRoom}
								disabled={pIsHere}
								class="mt-1 flex w-full items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-700 enabled:hover:border-accent-400 enabled:hover:bg-accent-50 enabled:hover:text-accent-700 disabled:cursor-default disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-200 dark:enabled:hover:border-accent-400 dark:enabled:hover:bg-accent-500/10 dark:enabled:hover:text-accent-300"
							>
								<span class="truncate">{pRoomName}</span>
								{#if !pIsHere}
									<ChevronRight size={14} class="shrink-0 opacity-60" />
								{:else}
									<span class="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">You're here</span>
								{/if}
							</button>
						</div>
					{:else if p.isOnline && !p.isSelf}
						<div class="text-xs text-neutral-500 dark:text-neutral-400">
							Online but not in any room.
						</div>
					{:else if !p.isOnline}
						{@const lastById = p.userId ? lastMessageByAuthor.byId.get(p.userId) ?? null : null}
						{@const lastByNick = lastMessageByAuthor.byNickname.get(p.nickname) ?? null}
						{@const lastMs = lastById ?? lastByNick}
						<div class="text-xs text-neutral-500 dark:text-neutral-400">
							{formatLastSeen(lastMs)}
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if lightbox}
		{@const m = lightbox}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Media preview"
			tabindex="-1"
			class="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
			onclick={closeLightbox}
			onwheel={lightboxWheel}
			transition:fly={{ duration: 180, y: 0, opacity: 0 }}
		>
			<button
				type="button"
				onclick={closeLightbox}
				aria-label="Close"
				class="absolute top-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
			>
				<X size={18} />
			</button>
			{#if galleryMedia.length > 1 && lightboxIndex >= 0}
				<div class="absolute top-4 left-4 z-10 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white">
					{lightboxIndex + 1} / {galleryMedia.length}
				</div>
			{/if}

			{#key m.id}
				<div
					in:fade={{ duration: 160 }}
					class="flex max-h-[88vh] max-w-[90vw] items-center justify-center"
				>
					{#if m.type === 'image'}
						<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
						<img
							src={m.src}
							alt={m.alt ?? ''}
							onclick={(e) => e.stopPropagation()}
							class="max-h-[88vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
						/>
					{:else}
						<!-- svelte-ignore a11y_media_has_caption a11y_click_events_have_key_events a11y_no_static_element_interactions -->
						<video
							src={m.src}
							controls
							autoplay
							loop
							playsinline
							onclick={(e) => e.stopPropagation()}
							class="max-h-[88vh] max-w-[90vw] rounded-lg shadow-2xl"
						></video>
					{/if}
				</div>
			{/key}

			<div
				onclick={(e) => e.stopPropagation()}
				role="presentation"
				class="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 p-1.5 ring-1 ring-white/10 backdrop-blur-sm"
			>
				<button
					type="button"
					onclick={prevLightbox}
					disabled={!hasPrev}
					aria-label="Previous"
					class="flex h-10 w-10 items-center justify-center rounded-full text-white enabled:hover:bg-white/15 disabled:opacity-30"
				>
					<ChevronLeft size={20} />
				</button>
				<button
					type="button"
					onclick={() => downloadMedia(m.src)}
					aria-label="Download"
					class="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/15"
				>
					<Download size={18} />
				</button>
				<button
					type="button"
					onclick={nextLightbox}
					disabled={!hasNext}
					aria-label="Next"
					class="flex h-10 w-10 items-center justify-center rounded-full text-white enabled:hover:bg-white/15 disabled:opacity-30"
				>
					<ChevronRight size={20} />
				</button>
			</div>
		</div>
	{/if}

	{#if roomContextMenu}
		{@const cm = roomContextMenu}
		{@const room = chatQuery.data?.rooms.find((r) => r.id === cm.roomId)}
		{@const showDelete = room ? canDeleteRoom(room) : false}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div
			role="menu"
			tabindex="-1"
			onclick={menuStopPropagation}
			oncontextmenu={(e) => e.preventDefault()}
			style="left: {cm.x}px; top: {cm.y}px;"
			class="fixed z-50 w-48 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
		>
			<button
				type="button"
				role="menuitem"
				onclick={() => leaveRoomFromMenu(cm.roomId)}
				class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
			>
				<LogOut size={14} />
				{cm.isDm ? 'Leave DM' : 'Leave room'}
			</button>
			{#if showDelete}
				<div class="my-1 border-t border-neutral-200 dark:border-neutral-700"></div>
				<button
					type="button"
					role="menuitem"
					onclick={() => deleteRoomFromMenu(cm.roomId, cm.isDm)}
					class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
				>
					<Trash2 size={14} />
					{cm.isDm ? 'Delete DM' : 'Delete room'}
				</button>
			{/if}
		</div>
	{/if}

{/if}
