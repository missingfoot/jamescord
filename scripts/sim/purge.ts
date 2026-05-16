// Wipes all rooms, messages, attachments, and profiles via the admin API.
// Does NOT delete $users — they're tied to InstantDB auth and need to be
// removed via the dashboard if you want a totally clean slate.
//
// Usage: npm run purge

import 'dotenv/config';
import { init, tx } from '@instantdb/admin';

const APP_ID = process.env.VITE_INSTANT_APP_ID;
const ADMIN_TOKEN = process.env.INSTANT_ADMIN_TOKEN;

if (!APP_ID) {
	console.error('VITE_INSTANT_APP_ID not set in .env');
	process.exit(1);
}
if (!ADMIN_TOKEN) {
	console.error('INSTANT_ADMIN_TOKEN not set in .env');
	process.exit(1);
}

const db = init({ appId: APP_ID, adminToken: ADMIN_TOKEN });

async function purge() {
	console.log('[purge] fetching everything…');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await db.query({
		rooms: {},
		messages: {},
		attachments: {},
		profiles: {}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	})) as any;

	const rooms = data.rooms ?? [];
	const messages = data.messages ?? [];
	const attachments = data.attachments ?? [];
	const profiles = data.profiles ?? [];

	const total = rooms.length + messages.length + attachments.length + profiles.length;
	if (total === 0) {
		console.log('[purge] already empty.');
		return;
	}

	console.log(
		`[purge] deleting ${rooms.length} room(s), ${messages.length} message(s), ${attachments.length} attachment(s), ${profiles.length} profile(s)…`
	);

	// Batched to avoid huge single-transaction payloads.
	const batchSize = 200;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ops: any[] = [
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		...messages.map((m: any) => tx.messages[m.id].delete()),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		...attachments.map((a: any) => tx.attachments[a.id].delete()),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		...rooms.map((r: any) => tx.rooms[r.id].delete()),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		...profiles.map((p: any) => tx.profiles[p.id].delete())
	];

	for (let i = 0; i < ops.length; i += batchSize) {
		const chunk = ops.slice(i, i + batchSize);
		await db.transact(chunk);
		console.log(`[purge] ${Math.min(i + batchSize, ops.length)} / ${ops.length}`);
	}

	console.log('[purge] done. $users are preserved — delete via dashboard if needed.');
}

purge().catch((err) => {
	console.error('[purge] failed:', err);
	process.exit(1);
});
