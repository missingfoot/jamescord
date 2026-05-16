// Admin-only: delete every message in a given room. Bypasses perms via the
// admin SDK after re-verifying the caller is on the ADMIN_EMAILS allow-list.

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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = (await adminDb.query({
			rooms: { $: { where: { id: roomId } }, messages: {} }
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		})) as any;
		const room = (data.rooms ?? [])[0];
		if (!room) return json({ error: 'room not found' }, { status: 404 });
		const messages: Array<{ id: string }> = room.messages ?? [];
		if (messages.length === 0) return json({ ok: true, deleted: 0 });

		const ops = messages.map((m) => tx.messages[m.id].delete());
		const batchSize = 200;
		for (let i = 0; i < ops.length; i += batchSize) {
			await adminDb.transact(ops.slice(i, i + batchSize));
		}
		return json({ ok: true, deleted: messages.length });
	} catch (err) {
		console.error('[admin/clear-room] failed:', err);
		return json({ error: 'clear failed' }, { status: 500 });
	}
};
