import 'dotenv/config';
// IMPORTANT: node-shims must load before @instantdb/core so its `window` shim
// runs before any Reactor is constructed. Import order matters here.
import { NodeInMemoryStore, AlwaysOnlineNetworkListener } from './node-shims.js';
import { init, tx, id, setInstantWarningsEnabled } from '@instantdb/core';
import { PERSONAS } from './personas.js';
import { PersonaClient } from './persona-client.js';

// Silence "Limits in child queries are only run client-side" — we know.
setInstantWarningsEnabled(false);

const APP_ID = process.env.VITE_INSTANT_APP_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!APP_ID) {
	console.error('VITE_INSTANT_APP_ID not set (loaded from .env)');
	process.exit(1);
}
if (!ANTHROPIC_KEY) {
	console.error('ANTHROPIC_API_KEY not set. Set it in your shell or .env:');
	console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
	process.exit(1);
}

// Seed a few starter rooms if the workspace has none, so personas have somewhere to talk.
const STARTER_ROOMS = ['general', 'random', 'frontend', 'backend'];

// Mirrors the helper in persona-client. Reactor.subscribeConnectionStatus only
// emits changes (no initial event), so check the private status first.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function waitForAuthenticated(db: any, timeoutMs: number): Promise<void> {
	if (db._reactor?.status === 'authenticated') return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			unsubscribe();
			console.warn('[sim] seed auth-status wait timed out');
			resolve();
		}, timeoutMs);
		const unsubscribe = db.subscribeConnectionStatus((status: string) => {
			if (status === 'authenticated' || status === 'errored') {
				clearTimeout(timer);
				unsubscribe();
				resolve();
			}
		});
	});
}

async function ensureStarterRooms(): Promise<void> {
	const seed = init(
		// __extraDedupeKey isolates this seed client from the per-persona clients.
		{
			appId: APP_ID!,
			useDateObjects: true,
			__extraDedupeKey: 'sim-seed'
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		NodeInMemoryStore as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		AlwaysOnlineNetworkListener as any
	);
	try {
		// Perms require auth.id — sign in as guest before any writes.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const authRes = (await seed.auth.signInAsGuest()) as any;
		const seedUserId: string | undefined = authRes?.user?.id;

		// Wait for the websocket to actually finish authenticating; otherwise
		// subscribeQuery fires on a mid-reconnect socket and never gets answered.
		await waitForAuthenticated(seed, 10_000);

		// queryOnce isn't available in Node — subscribe and await first result.
		const rooms = await new Promise<Array<{ id: string; kind?: string | null }>>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Timed out waiting for rooms query')),
				10_000
			);
			const unsub = seed.subscribeQuery({ rooms: {} }, (res) => {
				if (res.error) {
					clearTimeout(timeout);
					unsub();
					reject(new Error(res.error.message));
					return;
				}
				if (res.data) {
					clearTimeout(timeout);
					unsub();
					resolve(res.data.rooms);
				}
			});
		});

		const nonDm = rooms.filter((r) => r.kind !== 'dm');
		if (nonDm.length > 0) {
			console.log(`[sim] found ${nonDm.length} existing room(s); skipping seed`);
			return;
		}
		console.log(`[sim] seeding starter rooms: ${STARTER_ROOMS.join(', ')}`);
		await seed.transact(
			STARTER_ROOMS.map((name) =>
				tx.rooms[id()].update({
					name,
					createdAt: Date.now(),
					createdBy: 'sim',
					createdById: seedUserId
				})
			)
		);
	} finally {
		seed.shutdown();
	}
}

async function main(): Promise<void> {
	console.log(`[sim] starting with ${PERSONAS.length} personas`);
	console.log('[sim] personas will discover the human user via lobby presence');

	await ensureStarterRooms();

	const clients = PERSONAS.map((p) => new PersonaClient(p));
	// Sign every persona in first (populating KNOWN_SIM_USER_IDS) before any
	// of them subscribes / starts ticking. Otherwise a persona could miss a
	// peer's signin and mis-classify another persona as the human.
	// Staggered by 250ms each — parallel signins of 20 fresh guests appear to
	// overwhelm something in InstantDB's websocket auth handshake.
	console.log(`[sim] signing in ${clients.length} personas (staggered)…`);
	for (const c of clients) {
		await c.signIn();
		await new Promise((r) => setTimeout(r, 250));
	}
	console.log('[sim] all signed in. Starting ticks…');
	await Promise.all(clients.map((c) => c.start()));
	console.log(`[sim] all personas connected. Ctrl+C to stop.`);

	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log('\n[sim] shutting down…');
		for (const c of clients) c.stop();
		// Give InstantDB a moment to flush leave-presence updates before exit.
		setTimeout(() => process.exit(0), 500);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((err) => {
	console.error('[sim] fatal:', err);
	process.exit(1);
});
