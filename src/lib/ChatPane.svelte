<script lang="ts">
	import { tick, onMount, setContext, getContext } from 'svelte';
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { id } from '@instantdb/svelte';
	import { db } from '$lib/db';
	import LazyMedia from '$lib/LazyMedia.svelte';
	import VirtualGroup from '$lib/VirtualGroup.svelte';
	import {
		Plus,
		X,
		Pencil,
		Trash2,
		Reply as ReplyIcon,
		Paperclip,
		Smile,
		ChevronLeft,
		Users,
		FileVideo,
		ImageIcon,
		Loader2,
		Download,
		Columns2,
		CornerDownRight
	} from '$lib/icons';
	import Avatar from '$lib/Avatar.svelte';
	import SendIcon from '$lib/SendIcon.svelte';
	import { avatarColor, initials } from '$lib/avatar';
	import {
		ALLOWED_ACCEPT,
		ALLOWED_EXTS,
		MAX_BYTES,
		dmOtherName,
		dmOtherUserId,
		downloadMedia,
		fileExt,
		formatTime,
		inferContentType,
		isVideoExt,
		readMediaMeta,
		toMs,
		uploadToCloudinary
	} from '$lib/chatUtils';
	import { plog } from '$lib/perf.svelte';
	import { confirmDialog } from '$lib/confirm.svelte';

	type Room = {
		id: string;
		name: string;
		kind?: string | null;
		messages?: Msg[];
		members?: Array<{ id: string; userId?: string | null; nickname?: string | null }> | null;
	};
	type ReplyParent = {
		id: string;
		text: string;
		author: string;
		authorId?: string | null;
		media?: Attachment[];
	};
	type Msg = {
		id: string;
		text: string;
		author: string;
		authorId?: string | null;
		createdAt: number | string | Date;
		editedAt?: number | string | Date | null;
		replyTo?: ReplyParent | ReplyParent[] | null;
		media?: Attachment[] | null;
	};
	type Attachment = {
		id: string;
		url: string;
		path?: string | null;
		width?: number | null;
		height?: number | null;
		preview?: string | null;
		resourceType?: string | null;
	};

	let {
		roomId,
		rooms,
		nickname,
		userId,
		isFocused,
		showSplitButton = false,
		showCloseButton = false,
		showBackButton = false,
		showUsersButton = false,
		splitActive = false,
		splitDisabled = false,
		onFocus,
		onToggleSplit,
		onClose,
		onBack,
		onUsersClick
	}: {
		roomId: string | null;
		rooms: Room[];
		nickname: string;
		userId: string;
		isFocused: boolean;
		showSplitButton?: boolean;
		showCloseButton?: boolean;
		showBackButton?: boolean;
		showUsersButton?: boolean;
		splitActive?: boolean;
		splitDisabled?: boolean;
		onFocus: () => void;
		onToggleSplit?: () => void;
		onClose?: () => void;
		onBack?: () => void;
		onUsersClick?: () => void;
	} = $props();

	const openLightbox = getContext<
		| ((m: {
				id: string;
				src: string;
				type: 'image' | 'video';
				width?: number;
				height?: number;
				alt?: string;
		  }) => void)
		| undefined
	>('openLightbox');

	const getMyAliases = getContext<(() => string[]) | undefined>('myAliases');
	const myAliases = $derived<string[]>(getMyAliases?.() ?? (nickname ? [nickname] : []));

	// Set of $users IDs that currently exist. Used to detect "deleted" message
	// authors — their messages stay but the user record is gone.
	const getKnownUserIds = getContext<(() => Set<string>) | undefined>('knownUserIds');
	const knownUserIds = $derived<Set<string>>(getKnownUserIds?.() ?? new Set());

	const getIsAdmin = getContext<(() => boolean) | undefined>('isAdmin');
	const isAdmin = $derived<boolean>(getIsAdmin?.() ?? false);
	const clearRoomViaAdmin = getContext<((roomId: string) => Promise<void>) | undefined>(
		'clearRoomViaAdmin'
	);
	function isAuthorDeleted(authorId: string | null | undefined): boolean {
		// Only flag when we have an authorId to check; legacy messages with no
		// authorId can't be classified, so we leave them alone.
		return !!authorId && !knownUserIds.has(authorId);
	}

	const openProfile = getContext<
		| ((p: {
				userId: string | null;
				nickname: string;
				isOnline: boolean;
				currentRoomId: string | null;
				isSelf: boolean;
		  }) => void)
		| undefined
	>('openProfile');

	const reportAuthorPresence = getContext<
		| ((author: string) => {
				userId: string | null;
				isOnline: boolean;
				currentRoomId: string | null;
		  })
		| undefined
	>('authorPresence');

	// --- derived from props ---
	const activeRoom = $derived(rooms.find((r) => r.id === roomId) ?? null);
	const activeMessages = $derived<Msg[]>((activeRoom?.messages ?? []) as Msg[]);

	// For a DM, is the other participant deleted? Resolves the "other" userId
	// via dmOtherUserId (participants link → recent message authorId), then
	// checks against the known-users set from context.
	const dmOtherDeleted = $derived.by(() => {
		if (!activeRoom || activeRoom.kind !== 'dm') return false;
		const otherId = dmOtherUserId(activeRoom, userId);
		return !!otherId && !knownUserIds.has(otherId);
	});

	// --- per-pane state ---
	let messageText = $state('');
	let emojiPickerOpen = $state(false);
	let emojiPickerEl: HTMLDivElement | undefined = $state();
	let emojiButtonEl: HTMLButtonElement | undefined = $state();
	let messageListEl: HTMLDivElement | undefined = $state();
	let messageListInnerEl: HTMLDivElement | undefined = $state();
	let composerEl: HTMLTextAreaElement | undefined = $state();
	let fileInputEl: HTMLInputElement | undefined = $state();
	let stickToBottom = true;

	let scrollDirection: 'up' | 'down' | 'idle' = $state('idle');
	let scrollSpeed: 'slow' | 'fast' = $state('slow');
	let lastScrollTop = 0;
	let lastScrollTime = 0;
	let scrollIdleTimer: ReturnType<typeof setTimeout> | null = null;

	let contextMenu: { x: number; y: number; msg: Msg } | null = $state(null);
	let editingMsgId: string | null = $state(null);
	let editText = $state('');
	let editTextareaEl: HTMLTextAreaElement | undefined = $state();
	let replyingTo: Msg | null = $state(null);
	let flashingMsgId: string | null = $state(null);

	let uploadError: string | null = $state(null);
	type Toast = {
		id: string;
		name: string;
		fileId: string | null;
		state: 'uploading' | 'finalizing';
		progress: number;
		abort: (() => void) | null;
	};
	let toasts: Toast[] = $state([]);

	function addToast(t: Toast) {
		toasts = [...toasts, t];
	}
	function updateToast(id: string, patch: Partial<Toast>) {
		toasts = toasts.map((t) => (t.id === id ? { ...t, ...patch } : t));
	}
	function removeToast(toastId: string) {
		toasts = toasts.filter((t) => t.id !== toastId);
	}
	function markToastLoaded(fileId: string) {
		toasts = toasts.filter((t) => t.fileId !== fileId);
	}

	// expose context for LazyMedia (in this pane only)
	setContext('scrollDir', () => scrollDirection);
	setContext('scrollSpeed', () => scrollSpeed);
	setContext('onMediaReady', (fileId: string) => markToastLoaded(fileId));

	// --- scroll tracking ---
	function onMessagesScroll() {
		if (!messageListEl) return;
		const top = messageListEl.scrollTop;
		const dist = messageListEl.scrollHeight - top - messageListEl.clientHeight;
		stickToBottom = dist < 80;

		const now = performance.now();
		const delta = top - lastScrollTop;
		const dt = Math.max(1, now - lastScrollTime);
		const velocity = Math.abs(delta) / dt;
		if (Math.abs(delta) > 4) {
			const newDir = delta > 0 ? 'down' : 'up';
			const newSpeed = velocity > 1.5 ? 'fast' : 'slow';
			if (newDir !== scrollDirection || newSpeed !== scrollSpeed) {
				plog('scroll', `${newSpeed} ${newDir}`, { 'px/ms': velocity.toFixed(2) });
			}
			scrollDirection = newDir;
			scrollSpeed = newSpeed;
			lastScrollTop = top;
			lastScrollTime = now;
			if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
			scrollIdleTimer = setTimeout(() => {
				scrollDirection = 'idle';
				scrollSpeed = 'slow';
			}, 600);
		}
	}

	$effect(() => {
		if (!messageListInnerEl) return;
		const ro = new ResizeObserver(() => {
			if (stickToBottom && messageListEl) {
				messageListEl.scrollTop = messageListEl.scrollHeight;
			}
		});
		ro.observe(messageListInnerEl);
		return () => ro.disconnect();
	});

	$effect(() => {
		messageText;
		const el = composerEl;
		if (!el) return;
		el.style.height = 'auto';
		if (el.scrollHeight === 0) return;
		const max = 220;
		const desired = el.scrollHeight + 2;
		el.style.height = Math.min(desired, max) + 'px';
		el.style.overflowY = desired > max ? 'auto' : 'hidden';
	});

	$effect(() => {
		editText;
		const el = editTextareaEl;
		if (!el) return;
		el.style.height = 'auto';
		const max = 220;
		const desired = el.scrollHeight + 2;
		el.style.height = Math.min(desired, max) + 'px';
		el.style.overflowY = desired > max ? 'auto' : 'hidden';
	});

	$effect(() => {
		if (!emojiPickerOpen || !emojiPickerEl) return;
		const container = emojiPickerEl;
		let pickerEl: HTMLElement | null = null;
		let cancelled = false;
		Promise.all([import('emoji-mart'), import('@emoji-mart/data')]).then(
			([{ Picker }, dataMod]) => {
				if (cancelled) return;
				pickerEl = new Picker({
					data: dataMod.default,
					onEmojiSelect: (emoji: { native: string }) => {
						insertEmoji(emoji.native);
						emojiPickerOpen = false;
					},
					theme: 'auto',
					navPosition: 'bottom',
					previewPosition: 'none',
					skinTonePosition: 'search',
					autoFocus: true
				}) as unknown as HTMLElement;
				container.appendChild(pickerEl);
			}
		);
		return () => {
			cancelled = true;
			pickerEl?.remove();
		};
	});

	function insertEmoji(emoji: string) {
		const el = composerEl;
		if (!el) {
			messageText = messageText + emoji;
			return;
		}
		const start = el.selectionStart ?? messageText.length;
		const end = el.selectionEnd ?? messageText.length;
		messageText = messageText.slice(0, start) + emoji + messageText.slice(end);
		tick().then(() => {
			if (!composerEl) return;
			const pos = start + emoji.length;
			composerEl.focus();
			composerEl.setSelectionRange(pos, pos);
		});
	}

	// --- message grouping ---
	function replyParent(msg: Msg) {
		const r = msg.replyTo;
		if (!r) return null;
		if (Array.isArray(r)) return r[0] ?? null;
		return r;
	}

	const EMOJI_ONLY_RE =
		/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|️|‍|\s)+$/u;
	const graphemeSegmenter =
		typeof Intl !== 'undefined' && 'Segmenter' in Intl
			? new Intl.Segmenter('en', { granularity: 'grapheme' })
			: null;

	function emojiOnlySizeClass(text: string): string {
		const trimmed = text.trim();
		if (!trimmed || !EMOJI_ONLY_RE.test(trimmed)) return 'text-sm';
		let count = 0;
		if (graphemeSegmenter) {
			for (const { segment } of graphemeSegmenter.segment(trimmed)) {
				if (segment.trim()) count++;
			}
		} else {
			count = Array.from(trimmed).filter((c) => c.trim()).length;
		}
		if (count === 0) return 'text-sm';
		if (count <= 24) return 'text-5xl leading-tight';
		return 'text-sm';
	}

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

	type MessageGroup = {
		key: string;
		author: string;
		authorId?: string | null;
		startTime: number;
		messages: Msg[];
	};

	const GROUP_GAP_MS = 5 * 60 * 1000;

	const messageGroups = $derived.by<MessageGroup[]>(() => {
		const groups: MessageGroup[] = [];
		for (const msg of activeMessages) {
			const ts = toMs(msg.createdAt);
			const last = groups[groups.length - 1];
			if (
				last &&
				last.author === msg.author &&
				ts - toMs(last.messages[last.messages.length - 1].createdAt) <= GROUP_GAP_MS
			) {
				last.messages.push(msg);
			} else {
				groups.push({
					key: msg.id,
					author: msg.author,
					authorId: msg.authorId,
					startTime: ts,
					messages: [msg]
				});
			}
		}
		return groups;
	});

	// --- handlers ---
	async function sendMessage() {
		const text = messageText.trim();
		if (!text || !roomId || !nickname) return;
		const msgId = id();
		const links: { room: string; replyTo?: string } = { room: roomId };
		if (replyingTo) links.replyTo = replyingTo.id;
		db.transact(
			db.tx.messages[msgId]
				.update({ text, author: nickname, authorId: userId, createdAt: Date.now() })
				.link(links)
		);
		messageText = '';
		replyingTo = null;
		await tick();
		if (messageListEl) messageListEl.scrollTop = messageListEl.scrollHeight;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function openContextMenu(e: MouseEvent, msg: Msg) {
		e.preventDefault();
		const menuWidth = 192;
		const menuHeight = 200;
		const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
		const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
		contextMenu = { x, y, msg };
	}
	function closeContextMenu() {
		contextMenu = null;
	}

	async function deleteMessage(msg: Msg) {
		closeContextMenu();
		const ok = await confirmDialog({
			title: 'Delete this message?',
			confirmLabel: 'Delete',
			destructive: true
		});
		if (!ok) return;
		db.transact(db.tx.messages[msg.id].delete());
	}

	function startEdit(msg: Msg) {
		closeContextMenu();
		editingMsgId = msg.id;
		editText = msg.text;
	}
	function cancelEdit() {
		editingMsgId = null;
		editText = '';
	}
	function saveEdit() {
		if (!editingMsgId) return;
		const trimmed = editText.trim();
		if (!trimmed) return;
		db.transact(db.tx.messages[editingMsgId].update({ text: trimmed, editedAt: Date.now() }));
		editingMsgId = null;
		editText = '';
	}
	function handleEditKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			saveEdit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancelEdit();
		}
	}

	function startReply(msg: Msg) {
		closeContextMenu();
		replyingTo = msg;
		tick().then(() => composerEl?.focus());
	}

	function flashAndScroll(el: HTMLElement, msgId: string) {
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		flashingMsgId = msgId;
		setTimeout(() => {
			if (flashingMsgId === msgId) flashingMsgId = null;
		}, 1500);
	}

	function scrollToMessage(msgId: string) {
		const root = messageListEl;
		if (!root) return;
		const direct = root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(msgId)}"]`);
		if (direct) {
			flashAndScroll(direct, msgId);
			return;
		}
		const group = messageGroups.find((g) => g.messages.some((m) => m.id === msgId));
		if (!group) return;
		const groupEl = root.querySelector<HTMLElement>(
			`[data-group-id="${CSS.escape(group.key)}"]`
		);
		if (!groupEl) return;
		groupEl.scrollIntoView({ block: 'center' });
		let tries = 0;
		const tickFn = () => {
			tries++;
			const el = root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(msgId)}"]`);
			if (el) flashAndScroll(el, msgId);
			else if (tries < 12) setTimeout(tickFn, 50);
		};
		setTimeout(tickFn, 50);
	}

	async function clearRoom() {
		if (!activeRoom || !activeRoom.messages?.length) return;
		const count = activeRoom.messages.length;
		const ok = await confirmDialog({
			title: `Clear this chat?`,
			body: `All ${count} message${count === 1 ? '' : 's'} will be deleted.`,
			confirmLabel: 'Clear chat',
			destructive: true
		});
		if (!ok) return;
		// Admin-only action — goes through the server route that bypasses perms.
		try {
			await clearRoomViaAdmin?.(activeRoom.id);
		} catch (err) {
			await confirmDialog({
				title: 'Clear failed',
				body: err instanceof Error ? err.message : String(err),
				confirmLabel: 'OK',
				hideCancel: true
			});
		}
	}

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (!roomId || !nickname) return;
		const ext = fileExt(file.name);
		if (!ALLOWED_EXTS.includes(ext as (typeof ALLOWED_EXTS)[number])) {
			uploadError = `Unsupported file type: .${ext}`;
			return;
		}
		if (file.size > MAX_BYTES) {
			uploadError = 'File too large — must be under 25 MB.';
			return;
		}
		uploadError = null;
		const targetRoomId = roomId;
		const replyId = replyingTo?.id;
		replyingTo = null;
		const toastId = crypto.randomUUID();
		const handle = uploadToCloudinary(file, (pct) => updateToast(toastId, { progress: pct }));
		addToast({
			id: toastId,
			name: file.name,
			fileId: null,
			state: 'uploading',
			progress: 0,
			abort: handle.abort
		});
		try {
			const meta = await readMediaMeta(file);
			const contentType = file.type || inferContentType(ext);
			const cloud = await handle.promise;
			const attId = id();
			updateToast(toastId, { state: 'finalizing', progress: 100, fileId: attId, abort: null });
			db.transact(
				db.tx.attachments[attId].update({
					url: cloud.secure_url,
					contentType,
					width: cloud.width ?? meta?.width,
					height: cloud.height ?? meta?.height,
					...(meta?.preview ? { preview: meta.preview } : {}),
					cloudId: cloud.public_id,
					resourceType: cloud.resource_type ?? (isVideoExt(ext) ? 'video' : 'image'),
					createdAt: Date.now()
				})
			);
			const msgId = id();
			const links: { room: string; replyTo?: string; media?: string } = {
				room: targetRoomId,
				media: attId
			};
			if (replyId) links.replyTo = replyId;
			db.transact(
				db.tx.messages[msgId]
					.update({ text: '', author: nickname, authorId: userId, createdAt: Date.now() })
					.link(links)
			);
			setTimeout(() => removeToast(toastId), 15000);
		} catch (err) {
			removeToast(toastId);
			if (err instanceof DOMException && err.name === 'AbortError') return;
			const msg = err instanceof Error ? err.message : String(err);
			uploadError = `${msg || 'Upload failed'} (${file.name})`;
		}
	}

	function clickAuthor(authorName: string, knownAuthorId?: string | null) {
		const info = reportAuthorPresence?.(authorName);
		// Prefer the userId stored on the clicked message (authorId) when the
		// author is offline — presence won't have them, but their stable id is
		// still on the message itself.
		openProfile?.({
			userId: info?.userId ?? knownAuthorId ?? null,
			nickname: authorName,
			isOnline: info?.isOnline ?? false,
			currentRoomId: info?.currentRoomId ?? null,
			isSelf: authorName === nickname
		});
	}

	// Close context menu on outside click / escape
	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (contextMenu) closeContextMenu();
				else if (emojiPickerOpen) emojiPickerOpen = false;
				else if (replyingTo) replyingTo = null;
			}
		};
		const onDocClick = (e: MouseEvent) => {
			if (contextMenu) closeContextMenu();
			if (emojiPickerOpen) {
				const target = e.target as Node | null;
				if (
					target &&
					!emojiPickerEl?.contains(target) &&
					!emojiButtonEl?.contains(target)
				) {
					emojiPickerOpen = false;
				}
			}
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('click', onDocClick);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('click', onDocClick);
		};
	});

	// stop click outside menu from propagating
	function menuStopPropagation(e: MouseEvent) {
		e.stopPropagation();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<main
	onclick={onFocus}
	role="presentation"
	class="@container flex flex-1 flex-col overflow-hidden rounded-2xl border bg-white max-md:rounded-none max-md:border-0 dark:bg-neutral-900 {splitActive &&
	isFocused
		? 'border-accent-400 dark:border-accent-400'
		: 'border-neutral-200 dark:border-white/10'}"
>
	<header
		class="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800"
	>
		<div class="flex min-w-0 flex-1 items-center gap-2 text-sm">
			{#if showBackButton && onBack}
				<button
					type="button"
					onclick={(e) => {
						e.stopPropagation();
						onBack();
					}}
					aria-label="Back"
					class="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
				>
					<ChevronLeft size={20} />
				</button>
			{/if}
			{#if activeRoom}
				{#if activeRoom.kind === 'dm'}
					{@const other = dmOtherName(activeRoom, myAliases, userId)}
					{@const otherId = dmOtherUserId(activeRoom, userId)}
					<Avatar nickname={other} userId={otherId} size={24} rounded="rounded" textSize="text-[10px]" />
					<span class="truncate font-medium text-neutral-900 dark:text-neutral-100">{other}</span>
					<span class="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">DM</span>
				{:else}
					<span class="truncate font-medium text-neutral-900 dark:text-neutral-100">
						{activeRoom.name}
					</span>
					<span class="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">Room</span>
				{/if}
			{:else}
				<span class="text-neutral-400 dark:text-neutral-500">Select a room</span>
			{/if}
		</div>
		<div class="flex shrink-0 items-center gap-1">
			{#if showUsersButton && onUsersClick}
				<button
					type="button"
					onclick={(e) => {
						e.stopPropagation();
						onUsersClick();
					}}
					aria-label="Show users in this room"
					class="flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
				>
					<Users size={16} />
				</button>
			{/if}
			{#if activeMessages.length && isAdmin}
				<button
					type="button"
					onclick={(e) => {
						e.stopPropagation();
						clearRoom();
					}}
					aria-label="Clear all messages in this room"
					title="Clear all messages (admin)"
					class="flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-rose-50 hover:text-rose-600 dark:text-neutral-400 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
				>
					<Trash2 size={14} />
				</button>
			{/if}
			{#if showSplitButton && onToggleSplit}
				<button
					type="button"
					onclick={(e) => {
						e.stopPropagation();
						if (!splitDisabled) onToggleSplit();
					}}
					disabled={splitDisabled}
					aria-label="Add pane to the right"
					title={splitDisabled ? 'Not enough space to split' : 'Add pane'}
					class="flex h-7 w-7 items-center justify-center rounded text-neutral-500 enabled:hover:bg-neutral-100 enabled:hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400 dark:enabled:hover:bg-neutral-800 dark:enabled:hover:text-neutral-200"
				>
					<Columns2 size={14} />
				</button>
			{/if}
			{#if showCloseButton && onClose}
				<button
					type="button"
					onclick={(e) => {
						e.stopPropagation();
						onClose();
					}}
					aria-label="Close pane"
					title="Close pane"
					class="flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
				>
					<X size={14} />
				</button>
			{/if}
		</div>
	</header>

	{#if !roomId}
		<div class="flex flex-1 items-center justify-center text-sm text-neutral-400 dark:text-neutral-500">
			Select or create a room to start chatting.
		</div>
	{:else}
		<div class="flex flex-1 flex-col overflow-hidden">
			<div
				bind:this={messageListEl}
				onscroll={onMessagesScroll}
				data-scroll-root
				class="flex-1 overflow-y-auto py-4"
			>
				<div bind:this={messageListInnerEl}>
					{#if !activeMessages.length}
						<div class="px-6 text-sm text-neutral-400 dark:text-neutral-500">No messages yet. Say hi 👋</div>
					{:else}
						<ul class="space-y-5">
							{#each messageGroups as group (group.key)}
								<VirtualGroup groupId={group.key}>
									{#each group.messages as msg, i (msg.id)}
										{@const parent = replyParent(msg)}
										{@const isEditing = editingMsgId === msg.id}
										<div
											data-msg-id={msg.id}
											class="group/msg flex gap-3 px-4 py-1 {flashingMsgId === msg.id
												? 'bg-amber-100 dark:bg-amber-500/15'
												: contextMenu?.msg.id === msg.id
													? 'bg-neutral-100 dark:bg-neutral-800/60'
													: 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'}"
											oncontextmenu={(e) => openContextMenu(e, msg)}
											role="presentation"
										>
											<div class="w-9 shrink-0 @max-md:hidden">
												{#if i === 0}
													<button
														type="button"
														onclick={() => clickAuthor(group.author, group.authorId)}
														aria-label={`Open ${group.author}'s profile`}
														class="rounded-md hover:opacity-90"
													>
														<Avatar
															nickname={group.author}
															userId={group.authorId}
															size={36}
														/>
													</button>
												{:else}
													<span
														class="mt-1 hidden w-9 pr-2 text-right font-mono text-[10px] text-neutral-400 group-hover/msg:block dark:text-neutral-500"
														aria-hidden="true"
													>
														{formatTime(msg.createdAt)}
													</span>
												{/if}
											</div>
											<div class="min-w-0 flex-1">
												{#if i === 0}
													<div class="flex items-center gap-2 @max-md:mb-1.5 @md:items-baseline">
														<button
															type="button"
															onclick={() => clickAuthor(group.author, group.authorId)}
															aria-label={`Open ${group.author}'s profile`}
															class="shrink-0 rounded-md hover:opacity-90 @md:hidden"
														>
															<Avatar
																nickname={group.author}
																userId={group.authorId}
																size={36}
															/>
														</button>
														<div class="flex min-w-0 flex-col items-start @md:contents">
															<button
																type="button"
																onclick={() => clickAuthor(group.author, group.authorId)}
																class="text-sm font-semibold text-neutral-900 hover:underline dark:text-neutral-100"
															>
																{group.author}
															</button>
															<span class="text-xs text-neutral-400 dark:text-neutral-500">
																{formatTime(group.startTime)}
															</span>
														</div>
													</div>
												{/if}
												{#if parent}
													{@const pAtt = firstAttachment(parent as Msg)}
													{@const pAttIsVid = pAtt ? attachmentIsVideo(pAtt) : false}
													{@const pThumb = pAtt
														? pAttIsVid
															? pAtt.preview
															: pAtt.url || pAtt.preview
														: null}
													<button
														type="button"
														onclick={() => scrollToMessage(parent.id)}
														class="group/reply mb-1.5 flex w-full items-center gap-2 rounded-md py-1 pr-2 pl-1 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
													>
														<span class="self-stretch w-1 shrink-0 rounded-full bg-neutral-300 group-hover/reply:bg-accent-400 dark:bg-neutral-600 dark:group-hover/reply:bg-accent-400"></span>
														{#if pThumb}
															<img
																src={pThumb}
																alt=""
																aria-hidden="true"
																class="h-9 w-9 shrink-0 rounded object-cover"
															/>
														{/if}
														<div class="min-w-0 flex-1">
															<div class="font-medium text-neutral-700 dark:text-neutral-200">
																{parent.author}
															</div>
															{#if parent.text}
																<div class="truncate text-neutral-600 dark:text-neutral-300">
																	{parent.text}
																</div>
															{:else if pAtt}
																<div class="italic text-neutral-500 dark:text-neutral-400">
																	{attachmentLabel(pAtt)}
																</div>
															{/if}
														</div>
													</button>
												{/if}
												{#if isEditing}
													<div class="mt-0.5">
														<textarea
															bind:this={editTextareaEl}
															bind:value={editText}
															onkeydown={handleEditKeydown}
															rows="1"
															class="w-full min-w-0 resize-none rounded-md border border-accent-400 bg-white px-2 py-1.5 text-sm text-neutral-900 outline-none focus:border-accent-500 dark:border-accent-500 dark:bg-neutral-800 dark:text-neutral-100"
														></textarea>
														<div class="mt-1 flex items-center gap-2 text-xs">
															<button
																type="button"
																onclick={saveEdit}
																class="rounded bg-accent-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-accent-700 dark:bg-accent-500 dark:hover:bg-accent-400"
															>
																Save
															</button>
															<button
																type="button"
																onclick={cancelEdit}
																class="rounded px-2 py-0.5 text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
															>
																Cancel
															</button>
															<span class="text-neutral-400 dark:text-neutral-500">Enter to save · Esc to cancel</span>
														</div>
													</div>
												{:else}
													{#if msg.text}
														{@const sizeClass = emojiOnlySizeClass(msg.text)}
														<p class="whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-200 {sizeClass}">
															{msg.text}
															{#if msg.editedAt}
																<span class="ml-1 text-[10px] text-neutral-400 dark:text-neutral-500">(edited)</span>
															{/if}
														</p>
													{/if}
													{#if msg.media && msg.media.length}
														<div class="{msg.text || i === 0 ? 'mt-1.5' : ''} flex flex-wrap gap-2">
															{#each msg.media as att (att.id)}
																{@const isVid = attachmentIsVideo(att)}
																{#if att.url}
																	<LazyMedia
																		src={att.url}
																		type={isVid ? 'video' : 'image'}
																		width={att.width ?? undefined}
																		height={att.height ?? undefined}
																		preview={att.preview ?? undefined}
																		alt={att.url}
																		href={isVid ? undefined : att.url}
																		fileId={att.id}
																	/>
																{/if}
															{/each}
														</div>
													{/if}
													{#if msg.editedAt && !msg.text}
														<span class="text-[10px] text-neutral-400 dark:text-neutral-500">(edited)</span>
													{/if}
												{/if}
											</div>
										</div>
									{/each}
								</VirtualGroup>
							{/each}
						</ul>
					{/if}
				</div>
			</div>

			<div class="relative">
				<div class="pointer-events-none absolute -top-11 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1.5">
					{#each toasts as toast (toast.id)}
						<div
							in:fly={{ y: 12, duration: 220, easing: cubicOut }}
							out:fly={{ y: 12, duration: 180, easing: cubicOut }}
							class="pointer-events-auto flex w-72 max-w-[90vw] items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs shadow-sm dark:border-neutral-700 dark:bg-neutral-800"
						>
							{#if toast.state === 'uploading'}
								<span class="text-neutral-600 dark:text-neutral-300">
									Uploading {fileExt(toast.name) || 'file'}
								</span>
								<div class="h-1 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
									<div
										class="h-full rounded-full bg-accent-500 transition-[width] duration-150 dark:bg-accent-400"
										style="width: {toast.progress}%"
									></div>
								</div>
								<span class="w-8 shrink-0 text-right tabular-nums text-neutral-500 dark:text-neutral-400">
									{toast.progress}%
								</span>
								<button
									type="button"
									onclick={() => toast.abort?.()}
									aria-label="Cancel upload"
									class="shrink-0 rounded p-0.5 text-neutral-400 hover:text-rose-600 dark:text-neutral-500 dark:hover:text-rose-400"
								>
									<X size={12} />
								</button>
							{:else}
								<Loader2 size={12} class="shrink-0 animate-spin text-accent-500 dark:text-accent-400" />
								<span class="text-neutral-600 dark:text-neutral-300">
									Processing {fileExt(toast.name) || 'file'}…
								</span>
							{/if}
						</div>
					{/each}
				</div>

				<form
					onsubmit={(e) => {
						e.preventDefault();
						sendMessage();
					}}
					class="border-t border-neutral-200 bg-white p-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] dark:border-neutral-800 dark:bg-neutral-900"
				>
					{#if uploadError}
						<div class="mb-2 flex items-center gap-2 rounded-md bg-rose-50 px-3 py-1.5 text-xs text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">
							<span class="flex-1">{uploadError}</span>
							<button
								type="button"
								onclick={() => (uploadError = null)}
								aria-label="Dismiss error"
								class="rounded p-0.5 hover:bg-rose-100 dark:hover:bg-rose-500/20"
							>
								<X size={14} />
							</button>
						</div>
					{/if}
					{#if replyingTo}
						{@const rAtt = firstAttachment(replyingTo)}
						{@const rAttIsVid = rAtt ? attachmentIsVideo(rAtt) : false}
						{@const rThumb = rAtt
							? rAttIsVid
								? rAtt.preview
								: rAtt.url || rAtt.preview
							: null}
						<div class="mb-2 flex items-stretch gap-2 rounded-md bg-neutral-50 px-2 py-1.5 text-xs dark:bg-neutral-800/60">
							<span class="w-1 shrink-0 rounded-full bg-accent-500"></span>
							{#if rThumb}
								<img
									src={rThumb}
									alt=""
									aria-hidden="true"
									class="h-9 w-9 shrink-0 rounded object-cover"
								/>
							{/if}
							<div class="min-w-0 flex-1">
								<div class="text-neutral-500 dark:text-neutral-400">
									Replying to <span class="font-medium text-neutral-700 dark:text-neutral-200">{replyingTo.author}</span>
								</div>
								{#if replyingTo.text}
									<div class="truncate text-neutral-600 dark:text-neutral-300">{replyingTo.text}</div>
								{:else if rAtt}
									<div class="italic text-neutral-500 dark:text-neutral-400">{attachmentLabel(rAtt)}</div>
								{/if}
							</div>
							<button
								type="button"
								onclick={() => (replyingTo = null)}
								aria-label="Cancel reply"
								class="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-200"
							>
								<X size={14} />
							</button>
						</div>
					{/if}
					{#if dmOtherDeleted}
						<div class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-400">
							This user no longer exists. You can't reply here.
						</div>
					{:else}
					<div class="flex gap-2">
						<input
							bind:this={fileInputEl}
							type="file"
							accept={ALLOWED_ACCEPT}
							onchange={handleFileSelect}
							class="hidden"
						/>
						<div class="relative shrink-0 self-end">
							<button
								type="button"
								bind:this={emojiButtonEl}
								onclick={() => (emojiPickerOpen = !emojiPickerOpen)}
								aria-label="Insert emoji"
								aria-expanded={emojiPickerOpen}
								class="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-700 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
							>
								<Smile size={16} />
							</button>
							{#if emojiPickerOpen}
								<div
									bind:this={emojiPickerEl}
									class="absolute bottom-full left-0 z-50 mb-2 rounded-[10px] shadow-xl shadow-black/20 dark:shadow-black/60"
								></div>
							{/if}
						</div>
						<button
							type="button"
							onclick={() => fileInputEl?.click()}
							aria-label="Attach image or video"
							class="flex h-9 w-9 shrink-0 items-center justify-center self-end rounded-lg border border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-700 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
						>
							<Paperclip size={16} />
						</button>
						<textarea
							bind:this={composerEl}
							bind:value={messageText}
							onkeydown={handleKeydown}
							rows="1"
							placeholder="Message {activeRoom ? (activeRoom.kind === 'dm' ? dmOtherName(activeRoom, myAliases, userId) : activeRoom.name) : ''}"
							class="min-h-9 min-w-0 flex-1 resize-none rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-accent-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-accent-400"
						></textarea>
						<button
							type="submit"
							disabled={!messageText.trim()}
							aria-label="Send message"
							class="flex h-9 w-9 shrink-0 items-center justify-center self-end rounded-lg bg-accent-600 text-white hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-accent-500 dark:hover:bg-accent-400"
						>
							<SendIcon size={18} />
						</button>
					</div>
					{/if}
				</form>
			</div>
		</div>
	{/if}
</main>

{#if contextMenu}
	{@const cm = contextMenu}
	{@const isOwn = cm.msg.author === nickname}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		role="menu"
		tabindex="-1"
		onclick={menuStopPropagation}
		oncontextmenu={(e) => e.preventDefault()}
		style="left: {cm.x}px; top: {cm.y}px;"
		class="fixed z-50 w-48 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
	>
		{#if isOwn && !cm.msg.media?.length}
			<button
				type="button"
				role="menuitem"
				onclick={() => startEdit(cm.msg)}
				class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
			>
				<Pencil size={14} />
				Edit
			</button>
		{/if}
		<button
			type="button"
			role="menuitem"
			onclick={() => startReply(cm.msg)}
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
		>
			<ReplyIcon size={14} />
			Reply
		</button>
		{#if cm.msg.media?.[0]?.url}
			<button
				type="button"
				role="menuitem"
				onclick={() => {
					const url = cm.msg.media?.[0]?.url;
					closeContextMenu();
					if (url) downloadMedia(url);
				}}
				class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
			>
				<Download size={14} />
				Download
			</button>
		{/if}
		{#if isOwn}
			<div class="my-1 border-t border-neutral-200 dark:border-neutral-700"></div>
			<button
				type="button"
				role="menuitem"
				onclick={() => deleteMessage(cm.msg)}
				class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
			>
				<Trash2 size={14} />
				Delete
			</button>
		{/if}
	</div>
{/if}
