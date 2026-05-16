// Server-side helpers for the admin API routes. Centralised so the admin
// check, token verification, and DB initialisation live in one place.
//
// ADMIN_EMAILS is a comma-separated allow-list in .env. Stays server-side
// (no VITE_ prefix) so the client never learns which emails are admins.

import { env } from '$env/dynamic/private';
import { init } from '@instantdb/admin';

const APP_ID = env.VITE_INSTANT_APP_ID;
const ADMIN_TOKEN = env.INSTANT_ADMIN_TOKEN;

export const adminDb =
	APP_ID && ADMIN_TOKEN ? init({ appId: APP_ID, adminToken: ADMIN_TOKEN }) : null;

const ADMIN_EMAILS = new Set(
	(env.ADMIN_EMAILS ?? '')
		.split(',')
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean)
);

export type VerifiedUser = { id: string; email?: string | null; isAdmin: boolean };

/** Bearer-token authentication: returns the caller's user info + admin flag, or null. */
export async function verifyCaller(request: Request): Promise<VerifiedUser | null> {
	if (!adminDb) return null;
	const auth = request.headers.get('authorization') ?? '';
	const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
	if (!token) return null;
	let user: { id?: string; email?: string | null } | null = null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		user = (await adminDb.auth.verifyToken(token)) as any;
	} catch {
		return null;
	}
	if (!user?.id) return null;
	const email = user.email?.toLowerCase() ?? null;
	const isAdmin = !!email && ADMIN_EMAILS.has(email);
	return { id: user.id, email: user.email ?? null, isAdmin };
}

/** Throws-style helper for routes that require an admin caller. */
export async function requireAdmin(request: Request): Promise<VerifiedUser | { error: string; status: number }> {
	const caller = await verifyCaller(request);
	if (!caller) return { error: 'unauthorized', status: 401 };
	if (!caller.isAdmin) return { error: 'admin only', status: 403 };
	return caller;
}
