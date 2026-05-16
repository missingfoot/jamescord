// Dump all DM rooms and their participants via admin (bypasses perms) so we
// can see what's actually in the DB vs what the client perm-filter shows.
//
// Usage: npx tsx scripts/sim/debug-dms.ts

import 'dotenv/config';
import { init } from '@instantdb/admin';

const APP_ID = process.env.VITE_INSTANT_APP_ID;
const ADMIN_TOKEN = process.env.INSTANT_ADMIN_TOKEN;
if (!APP_ID || !ADMIN_TOKEN) {
	console.error('Missing VITE_INSTANT_APP_ID or INSTANT_ADMIN_TOKEN in .env');
	process.exit(1);
}

const db = init({ appId: APP_ID, adminToken: ADMIN_TOKEN });

async function main() {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await db.query({
		rooms: {
			$: { where: { kind: 'dm' } },
			members: {},
			messages: {}
		},
		profiles: {}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	})) as any;

	const profiles: Array<{ id: string; nickname: string; userId?: string }> = data.profiles ?? [];
	console.log(`\n${profiles.length} profiles:`);
	for (const p of profiles) {
		console.log(`  profile ${p.id}  nickname="${p.nickname}"  userId=${p.userId ?? '(missing)'}`);
	}

	const rooms = data.rooms ?? [];
	console.log(`\n${rooms.length} DM rooms:`);
	for (const r of rooms) {
		console.log(`\n  room ${r.id}`);
		console.log(`    name: ${r.name}`);
		console.log(`    createdById: ${r.createdById}`);
		console.log(`    messages: ${r.messages?.length ?? 0}`);
		const parts = r.members ?? [];
		console.log(`    members: ${parts.length} link rows`);
		for (const p of parts) {
			const matchingProfile = profiles.find((x) => x.id === p.id);
			console.log(
				`      member.id=${p.id}  ${matchingProfile ? `→ ${matchingProfile.nickname} (userId=${matchingProfile.userId})` : '(no matching profile!)'}`
			);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
