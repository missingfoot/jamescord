// IMPORTANT: node-shims must load before @instantdb/core (sets `window` global).
import { NodeInMemoryStore, AlwaysOnlineNetworkListener } from './node-shims.js';
import { init, tx, id, type InstantCoreDatabase } from '@instantdb/core';
import { generateMessage, generateDmToUser, type RecentMessage } from './claude.js';
import {
	TEMPO_ACT_PROBABILITY,
	TEMPO_INTERVAL_MS,
	type Persona
} from './personas.js';

type Room = {
	id: string;
	name: string;
	kind?: string | null;
};

type Message = {
	id: string;
	text: string;
	author: string;
	createdAt: number | string | Date;
};

type RoomWithMessages = Room & { messages?: Message[] };

type LobbyHandle = ReturnType<InstantCoreDatabase['joinRoom']>;

type PeerPresence = {
	nickname?: string;
	userId?: string;
	currentRoomId?: string | null;
};

// Shared across all PersonaClients in this process. Populated after each
// persona signs in, used to filter "humans" from "personas" when scanning
// the lobby presence for DM targets.
const KNOWN_SIM_USER_IDS = new Set<string>();

// Probabilities per online tick (after the act/idle gate).
const P_GO_OFFLINE = 0.08;
const P_DM_USER = 0.06;
const P_SWITCH_ROOM = 0.2;
// Probability per offline tick to come online.
const P_COME_ONLINE = 0.25;

function dmKeyFor(a: string, b: string): string {
	return [a, b].sort().join('|');
}

function toMs(t: number | string | Date): number {
	if (t instanceof Date) return t.getTime();
	if (typeof t === 'number') return t;
	return new Date(t).getTime();
}

function pickWeighted(rooms: Room[], persona: Persona): Room | null {
	const nonDm = rooms.filter((r) => r.kind !== 'dm');
	if (!nonDm.length) return null;
	const scored = nonDm.map((r) => {
		const lower = r.name.toLowerCase();
		const matches = persona.interests.filter((tag) => lower.includes(tag)).length;
		return { room: r, weight: 1 + matches * 3 };
	});
	const total = scored.reduce((s, x) => s + x.weight, 0);
	let roll = Math.random() * total;
	for (const s of scored) {
		roll -= s.weight;
		if (roll <= 0) return s.room;
	}
	return scored[scored.length - 1]?.room ?? null;
}

export class PersonaClient {
	persona: Persona;
	private db: InstantCoreDatabase;
	// Assigned after signInAsGuest resolves.
	private authUserId: string | null = null;
	private profileId: string | null = null;
	private rooms: RoomWithMessages[] = [];
	private profilesByUserId: Map<string, string> = new Map();
	private lobbyPeers: Record<string, PeerPresence> = {};
	private online = false;
	private currentRoomId: string | null = null;
	// Single lobby handle reused for both subscribePresence and publishPresence.
	private lobby: LobbyHandle | null = null;
	private tickTimer: NodeJS.Timeout | null = null;
	private unsubscribeRooms: (() => void) | null = null;
	private unsubscribePresence: (() => void) | null = null;
	private unsubscribeProfiles: (() => void) | null = null;
	private hasInitialData = false;

	constructor(persona: Persona) {
		this.persona = persona;
		const appId = process.env.VITE_INSTANT_APP_ID;
		if (!appId) throw new Error('VITE_INSTANT_APP_ID is not set');
		// __extraDedupeKey is undocumented but necessary: init() returns a
		// cached Reactor keyed on appId, so without a unique key per persona
		// all 20 personas would share one connection and one auth identity.
		this.db = init(
			{
				appId,
				useDateObjects: true,
				__extraDedupeKey: `sim-${persona.userId}`
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			NodeInMemoryStore as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			AlwaysOnlineNetworkListener as any
		);
	}

	// Two-phase startup so the orchestrator can sign in all personas first
	// (populating KNOWN_SIM_USER_IDS) before any persona starts ticking and
	// trying to discover the human via presence.
	async signIn(): Promise<void> {
		const res = await this.db.auth.signInAsGuest();
		// `res.user.id` is the stable InstantDB user id for this guest.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const userId = (res as any).user?.id as string | undefined;
		if (!userId) throw new Error(`signInAsGuest returned no user.id for ${this.persona.nickname}`);
		this.authUserId = userId;
		KNOWN_SIM_USER_IDS.add(userId);
		await this.ensureProfile();
	}

	async start(): Promise<void> {
		if (!this.authUserId) throw new Error('start() called before signIn()');

		// Wait for the websocket to finish authenticating with the credentials
		// signIn() acquired. Without this, subscribeQuery/joinRoom calls fire on
		// the wrong (mid-reconnect) connection and silently never get answered.
		await this.waitForAuthenticated(30_000);

		// Subscribe to rooms with their messages + participants. Need participants
		// to detect "is this DM already between me and that human?" by link, not name.
		this.unsubscribeRooms = this.db.subscribeQuery(
			{
				rooms: {
					messages: {
						$: { order: { createdAt: 'asc' }, limit: 30 }
					},
					members: {}
				}
			},
			(res) => {
				if (res.error) {
					console.error(`[${this.persona.nickname}] query error:`, res.error.message);
					return;
				}
				if (res.data) {
					this.rooms = res.data.rooms as RoomWithMessages[];
					this.hasInitialData = true;
				}
			}
		);

		// Track userId -> profileId so dmTheUser can link DMs to the human's
		// profile (the participants link target is profiles now).
		this.unsubscribeProfiles = this.db.subscribeQuery({ profiles: {} }, (res) => {
			if (res.data) {
				const map = new Map<string, string>();
				for (const p of res.data.profiles ?? []) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const prof = p as any;
					if (prof.userId && prof.id) map.set(prof.userId, prof.id);
				}
				this.profilesByUserId = map;
			}
		});

		// Always-on lobby join so we can discover humans via presence. We publish
		// presence with our nickname + userId; we update currentRoomId as we move.
		this.lobby = this.db.joinRoom('lobby', 'global', {
			initialPresence: {
				nickname: this.persona.nickname,
				userId: this.authUserId
			}
		});
		this.unsubscribePresence = this.lobby.subscribePresence({}, (slice) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const peers = ((slice as any).peers ?? {}) as Record<string, PeerPresence>;
			this.lobbyPeers = peers;
		});

		await this.waitForInitialData(5000);
		this.scheduleNextTick(true);
	}

	stop(): void {
		if (this.tickTimer) clearTimeout(this.tickTimer);
		this.unsubscribeRooms?.();
		this.unsubscribePresence?.();
		this.unsubscribeProfiles?.();
		if (this.lobby) this.lobby.leaveRoom();
		this.db.shutdown();
	}

	private async ensureProfile(): Promise<void> {
		if (!this.authUserId) return;
		// Each persona gets a fresh guest user per run, so we always create.
		const profileId = id();
		await this.db.transact(
			tx.profiles[profileId]
				.update({
					nickname: this.persona.nickname,
					userId: this.authUserId,
					createdAt: Date.now()
				})
				.link({ user: this.authUserId })
		);
		this.profileId = profileId;
	}

	private findHuman(): { userId: string; nickname: string } | null {
		for (const peer of Object.values(this.lobbyPeers)) {
			if (!peer.userId) continue;
			if (KNOWN_SIM_USER_IDS.has(peer.userId)) continue;
			return { userId: peer.userId, nickname: peer.nickname ?? 'them' };
		}
		return null;
	}

	private async waitForInitialData(timeoutMs: number): Promise<void> {
		const start = Date.now();
		while (!this.hasInitialData && Date.now() - start < timeoutMs) {
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	private waitForAuthenticated(timeoutMs: number): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const reactor = (this.db as any)._reactor;
		const initialStatus = reactor?.status;
		if (initialStatus === 'authenticated') return Promise.resolve();

		const statusHistory: string[] = [initialStatus ?? 'unknown'];
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				console.warn(
					`[${this.persona.nickname}] auth-status timeout. Statuses seen: ${statusHistory.join(' → ')}`
				);
				resolve();
			}, timeoutMs);
			const unsubscribe = this.db.subscribeConnectionStatus((status: string) => {
				statusHistory.push(status);
				if (status === 'authenticated') {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				} else if (status === 'errored') {
					clearTimeout(timer);
					unsubscribe();
					reject(new Error('connection errored before authenticating'));
				}
			});
		});
	}

	private scheduleNextTick(firstRun = false): void {
		const [min, max] = TEMPO_INTERVAL_MS[this.persona.tempo];
		const delay = firstRun ? Math.random() * max : min + Math.random() * (max - min);
		this.tickTimer = setTimeout(() => {
			this.tick().finally(() => this.scheduleNextTick());
		}, delay);
	}

	private async tick(): Promise<void> {
		try {
			if (!this.online) {
				if (Math.random() < P_COME_ONLINE) this.goOnline();
				return;
			}
			if (Math.random() < P_GO_OFFLINE) {
				this.goOffline();
				return;
			}
			if (Math.random() >= TEMPO_ACT_PROBABILITY[this.persona.tempo]) return;
			await this.act();
		} catch (err) {
			console.error(
				`[${this.persona.nickname}] tick error:`,
				err instanceof Error ? err.message : err
			);
		}
	}

	private goOnline(): void {
		const room = pickWeighted(this.rooms, this.persona);
		this.currentRoomId = room?.id ?? null;
		this.lobby?.publishPresence({
			nickname: this.persona.nickname,
			userId: this.authUserId!,
			currentRoomId: this.currentRoomId ?? undefined
		});
		this.online = true;
		console.log(`[${this.persona.nickname}] online${room ? ` in ${room.name}` : ''}`);
	}

	private goOffline(): void {
		// Keep them in the lobby so presence-based discovery still works for
		// other personas. Just clear their currentRoomId.
		this.lobby?.publishPresence({
			nickname: this.persona.nickname,
			userId: this.authUserId!,
			currentRoomId: undefined
		});
		this.online = false;
		this.currentRoomId = null;
		console.log(`[${this.persona.nickname}] offline`);
	}

	private async act(): Promise<void> {
		if (Math.random() < P_DM_USER) {
			await this.dmTheUser();
			return;
		}
		if (Math.random() < P_SWITCH_ROOM) {
			const next = pickWeighted(this.rooms, this.persona);
			if (next && next.id !== this.currentRoomId) {
				this.currentRoomId = next.id;
				this.lobby?.publishPresence({
					nickname: this.persona.nickname,
					userId: this.authUserId!,
					currentRoomId: next.id
				});
			}
		}
		if (!this.currentRoomId) return;
		await this.postInRoom(this.currentRoomId);
	}

	private async postInRoom(roomId: string): Promise<void> {
		const room = this.rooms.find((r) => r.id === roomId);
		if (!room) return;
		const recent: RecentMessage[] = (room.messages ?? [])
			.slice()
			.sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt))
			.slice(-12)
			.map((m) => ({ author: m.author, text: m.text }));

		if (recent.length && recent[recent.length - 1].author === this.persona.nickname) return;

		const text = await generateMessage(this.persona, room.name, recent);
		if (!text) return;
		await this.writeMessage(text, roomId);
		console.log(`[${this.persona.nickname}] in ${room.name}: ${text}`);
	}

	private async dmTheUser(): Promise<void> {
		if (!this.authUserId || !this.profileId) return;
		const human = this.findHuman();
		if (!human) return; // no human online
		const humanProfileId = this.profilesByUserId.get(human.userId);
		if (!humanProfileId) return; // human hasn't created a profile yet
		const key = dmKeyFor(this.authUserId, human.userId);
		let dmRoom = this.rooms.find((r) => r.kind === 'dm' && r.name === key);
		let roomId: string;
		if (!dmRoom) {
			roomId = id();
			try {
				await this.db.transact(
					tx.rooms[roomId]
						.update({
							name: key,
							kind: 'dm',
							createdAt: Date.now(),
							createdBy: this.persona.nickname,
							createdById: this.authUserId
						})
						.link({ members: [this.profileId, humanProfileId] })
				);
			} catch (err) {
				// Race with another sim tick or the human creating the same DM.
				// Skip this tick; the next will find the existing room via this.rooms.
				const msg = err instanceof Error ? err.message : String(err);
				if (/rooms\.name|record-not-unique|already exists/i.test(msg)) return;
				throw err;
			}
		} else {
			roomId = dmRoom.id;
		}
		const recent: RecentMessage[] = (dmRoom?.messages ?? [])
			.slice()
			.sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt))
			.slice(-8)
			.map((m) => ({ author: m.author, text: m.text }));

		if (recent.length && recent[recent.length - 1].author === this.persona.nickname) return;

		const text = await generateDmToUser(this.persona, human.nickname, recent);
		if (!text) return;
		await this.writeMessage(text, roomId);
		console.log(`[${this.persona.nickname}] DM → ${human.nickname}: ${text}`);
	}

	private async writeMessage(text: string, roomId: string): Promise<void> {
		const msgId = id();
		await this.db.transact(
			tx.messages[msgId]
				.update({
					text,
					author: this.persona.nickname,
					authorId: this.authUserId ?? undefined,
					createdAt: Date.now()
				})
				.link({ room: roomId })
		);
	}
}
