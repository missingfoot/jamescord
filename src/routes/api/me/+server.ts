// Returns the caller's role info. We don't expose email here — only the
// boolean `isAdmin` flag. The server keeps the admin email list private.

import { json, type RequestHandler } from '@sveltejs/kit';
import { verifyCaller } from '$lib/server/admin';

export const POST: RequestHandler = async ({ request }) => {
	const caller = await verifyCaller(request);
	if (!caller) return json({ error: 'unauthorized' }, { status: 401 });
	return json({ isAdmin: caller.isAdmin });
};
