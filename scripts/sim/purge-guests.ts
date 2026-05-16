// Deletes guest $users (and their profiles) that have been inactive for
// longer than the given threshold (default 24 hours).
//
// "Inactive" is measured by profile.createdAt — a coarse signal but it's
// the cheapest one we have without per-user activity tracking. Sim runs
// always create profiles immediately on signin, so the profile timestamp
// is an OK proxy for the persona's birth time.
//
// Usage:
//   npm run purge-guests           # default: 24m (set low for testing — bump
//                                  # the DEFAULT_THRESHOLD_MS in this file
//                                  # back to 24h once you're done iterating)
//   npm run purge-guests 24m       # 24 minutes
//   npm run purge-guests 24h       # 24 hours
//   npm run purge-guests 24        # bare number = hours (back-compat)
//
// $users created via email signin (no `type` or `type !== 'guest'`) are
// untouched.

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

const DEFAULT_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes — change back to `24 * 60 * 60 * 1000` for 24h

function parseDuration(arg: string | undefined): number {
	if (!arg) return DEFAULT_THRESHOLD_MS;
	const m = arg.match(/^(\d+(?:\.\d+)?)([hm]?)$/i);
	if (!m) throw new Error(`Invalid duration: ${arg} (try "24m", "24h", or "1")`);
	const value = Number(m[1]);
	const unit = m[2].toLowerCase();
	const unitMs = unit === 'm' ? 60 * 1000 : 60 * 60 * 1000; // default = hours
	return value * unitMs;
}

let thresholdMs: number;
try {
	thresholdMs = parseDuration(process.argv[2]);
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
}
const cutoffMs = Date.now() - thresholdMs;

const db = init({ appId: APP_ID, adminToken: ADMIN_TOKEN });

// The admin SDK returns linked entities as arrays even for 1:1 links.
// Always take user[0].
type LinkedUser = { id: string; type?: string | null; email?: string | null };
type ProfileWithUser = {
	id: string;
	createdAt: string | number;
	nickname?: string;
	user?: LinkedUser[] | null;
};

async function purge() {
	console.log(
		`[purge-guests] cutoff: ${new Date(cutoffMs).toISOString()} (older than ${Math.round(thresholdMs / 60000)}m)`
	);
	// Query $users directly + their (optional) profile. We need to source from
	// $users (not profiles) so we also catch orphaned $users whose profile was
	// already deleted in a prior run.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const data = (await db.query({ $users: { profile: {} } })) as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const users: any[] = data.$users ?? [];

	if (users.length === 0) {
		console.log('[purge-guests] no users in db.');
		return;
	}

	// Filter to guest users (no email) whose profile is missing or older than
	// the cutoff. If there's no profile at all, treat as immediately purgeable —
	// it's either a brand-new signin that never picked a nickname (rare) or an
	// orphan from a previous partial purge.
	console.log(`[purge-guests] scanning ${users.length} user(s)…`);
	const stale = users
		.map((u) => ({ user: u, profile: u.profile?.[0] }))
		.filter(({ user, profile }) => {
			if (!user || !user.id) return false;
			const hasEmail = typeof user.email === 'string' && user.email.length > 0;
			if (hasEmail) return false; // skip real accounts
			if (!profile) return true; // orphan — purge now
			const createdMs =
				typeof profile.createdAt === 'number'
					? profile.createdAt
					: new Date(profile.createdAt).getTime();
			return createdMs < cutoffMs;
		});

	if (stale.length === 0) {
		console.log('[purge-guests] nothing stale.');
		return;
	}

	console.log(`[purge-guests] deleting ${stale.length} stale guest(s)…`);

	// Delete any still-present profiles via tx (skip orphans with no profile).
	const profileOps = stale
		.filter(({ profile }) => !!profile)
		.map(({ profile }) => tx.profiles[profile!.id].delete());
	if (profileOps.length > 0) {
		const batchSize = 200;
		for (let i = 0; i < profileOps.length; i += batchSize) {
			await db.transact(profileOps.slice(i, i + batchSize));
		}
	}

	// Delete $users via the auth admin API — tx.$users[id].delete() silently
	// no-ops for auth-managed entities. One HTTP call per user; cap concurrency.
	let done = 0;
	const concurrency = 5;
	let cursor = 0;
	async function worker() {
		while (cursor < stale.length) {
			const i = cursor++;
			const { user } = stale[i];
			if (!user) continue;
			try {
				await db.auth.deleteUser({ id: user.id });
			} catch (err) {
				console.warn(
					`[purge-guests] failed to delete user ${user.id}:`,
					err instanceof Error ? err.message : err
				);
			}
			done++;
			if (done % 5 === 0 || done === stale.length) {
				console.log(`[purge-guests] users deleted: ${done} / ${stale.length}`);
			}
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker));
	console.log('[purge-guests] done.');
}

purge().catch((err) => {
	console.error('[purge-guests] failed:', err);
	process.exit(1);
});
