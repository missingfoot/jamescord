// Self-delete endpoint. The client posts here with its refresh token in the
// Authorization header; we verify the token (which tells us the caller's
// $users.id), then delete their profile + the user.
//
// INSTANT_ADMIN_TOKEN must be set in .env (it already is). It stays server-side —
// no VITE_ prefix means SvelteKit's private-env loader never ships it to the
// browser.

import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { init, tx } from '@instantdb/admin';

const APP_ID = env.VITE_INSTANT_APP_ID;
const ADMIN_TOKEN = env.INSTANT_ADMIN_TOKEN;

const db =
	APP_ID && ADMIN_TOKEN ? init({ appId: APP_ID, adminToken: ADMIN_TOKEN }) : null;

export const POST: RequestHandler = async ({ request }) => {
	if (!db) {
		return json(
			{ error: 'server is missing VITE_INSTANT_APP_ID or INSTANT_ADMIN_TOKEN' },
			{ status: 500 }
		);
	}

	const authHeader = request.headers.get('authorization') ?? '';
	const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
	if (!token) {
		return json({ error: 'missing bearer token' }, { status: 401 });
	}

	let user: { id: string } | null = null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		user = (await db.auth.verifyToken(token)) as any;
	} catch (err) {
		console.warn('[delete-account] verifyToken failed:', err);
		return json({ error: 'invalid or expired token' }, { status: 401 });
	}
	if (!user?.id) {
		return json({ error: 'token did not resolve to a user' }, { status: 401 });
	}

	// Delete the profile (if any) before the $users record. Filter via the
	// denormalized userId field.
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = (await db.query({
			profiles: { $: { where: { userId: user.id } } }
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		})) as any;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const profile = (data.profiles ?? [])[0] as { id?: string } | undefined;
		if (profile?.id) {
			await db.transact([tx.profiles[profile.id].delete()]);
		}
	} catch (err) {
		console.warn('[delete-account] profile cleanup failed (continuing):', err);
	}

	try {
		await db.auth.deleteUser({ id: user.id });
	} catch (err) {
		console.error('[delete-account] deleteUser failed:', err);
		return json({ error: 'delete failed' }, { status: 500 });
	}

	return json({ ok: true });
};
