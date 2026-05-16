// Admin-only: delete a non-DM room (rooms.message link cascade-deletes its
// messages). DM deletion is a separate path — those go through the regular
// client transact since both participants are allowed.

import { json, type RequestHandler } from '@sveltejs/kit';
import { tx } from '@instantdb/admin';
import { adminDb, requireAdmin } from '$lib/server/admin';

export const POST: RequestHandler = async ({ request }) => {
	if (!adminDb) return json({ error: 'server misconfigured' }, { status: 500 });
	const caller = await requireAdmin(request);
	if ('error' in caller) return json({ error: caller.error }, { status: caller.status });

	let body: { roomId?: string };
	try {
		body = (await request.json()) ?? {};
	} catch {
		return json({ error: 'bad json' }, { status: 400 });
	}
	const roomId = body.roomId?.trim();
	if (!roomId) return json({ error: 'missing roomId' }, { status: 400 });

	try {
		await adminDb.transact([tx.rooms[roomId].delete()]);
		return json({ ok: true });
	} catch (err) {
		console.error('[admin/delete-room] failed:', err);
		return json({ error: 'delete failed' }, { status: 500 });
	}
};
