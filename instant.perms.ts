import type { InstantRules } from '@instantdb/svelte';

// Auth-gated ownership. Identity comes from `auth.id` (InstantDB auth user id).
// Rooms store the creator id as `createdById`; messages store the author id as
// `authorId` — both denormalized strings so perm expressions can do scalar
// comparisons rather than link traversals.
//
// `data.ref('link.field')` returns a list (even for 1:1 links), hence the
// `in` / `!('x' in ...)` patterns instead of `==` / `!=`.
const rules: InstantRules = {
	// Self-only. Emails live on $users (managed by InstantDB auth) and we
	// never want them visible to other accounts. Cross-user identity info
	// (nickname, userId) is on the public `profiles` entity instead.
	$users: {
		allow: {
			view: 'auth.id == data.id'
		}
	},
	rooms: {
		allow: {
			// Non-DM rooms are public. DM rooms are visible only to members.
			// `members` is the new rooms→profiles link; traverse to members.userId.
			view: "data.kind != 'dm' || auth.id in data.ref('members.userId')",
			create: 'auth.id != null && auth.id == data.createdById',
			update: "data.kind == 'dm' && auth.id in data.ref('members.userId')",
			delete: "data.kind == 'dm' && auth.id in data.ref('members.userId')"
		}
	},
	messages: {
		allow: {
			view: "!('dm' in data.ref('room.kind')) || auth.id in data.ref('room.members.userId')",
			create:
				"auth.id == data.authorId && (!('dm' in data.ref('room.kind')) || auth.id in data.ref('room.members.userId'))",
			update: 'auth.id == data.authorId',
			delete:
				"auth.id == data.authorId || ('dm' in data.ref('room.kind') && auth.id in data.ref('room.members.userId'))"
		}
	},
	profiles: {
		allow: {
			// Nicknames are public.
			view: 'true',
			// Profile must point at the caller (denormalized userId field). No
			// spoofing a profile for someone else.
			create: 'auth.id == data.userId',
			update: 'auth.id == data.userId',
			delete: 'auth.id == data.userId'
		}
	},
	$files: {
		// File ownership isn't tracked in the schema today; gating these would
		// require adding an owner field + denormalizing onto attachments. For
		// now anyone authed can read/write. If you care, ping me and we'll add
		// an `uploadedById` field and tighten these.
		allow: {
			view: 'true',
			create: 'auth.id != null',
			update: 'auth.id != null',
			delete: 'auth.id != null'
		}
	},
	attachments: {
		allow: {
			view: 'true',
			create: 'auth.id != null',
			update: 'auth.id != null',
			delete: 'auth.id != null'
		}
	}
};

export default rules;
