export function fileExt(path: string | undefined): string {
	if (!path) return '';
	const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
	return m ? m[1] : '';
}

export function isVideoExt(ext: string): boolean {
	return ext === 'mp4' || ext === 'webm';
}

export function inferContentType(ext: string): string {
	switch (ext) {
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
		case 'jfif':
			return 'image/jpeg';
		case 'webp':
			return 'image/webp';
		case 'gif':
			return 'image/gif';
		case 'webm':
			return 'video/webm';
		case 'mp4':
			return 'video/mp4';
		default:
			return 'application/octet-stream';
	}
}

export function toMs(d: Date | string | number): number {
	return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

export function formatTime(d: Date | string | number): string {
	const date = d instanceof Date ? d : new Date(d);
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dmKeyFor(a: string, b: string): string {
	return [a, b].sort().join('|');
}

// Resolve the *other* participant's display name for a DM.
//
// Resolution order:
//   1. participants link → other.profile.nickname (live + survives renames)
//   2. most recent non-me message author (nickname snapshot — survives deletion)
//   3. legacy room.name split (only when the part doesn't look like a UUID,
//      because new room.names are sorted userIds and showing those is gibberish)
//   4. 'Deleted user' — the other side is gone with no trace left
//
// `me` may be a nickname or a list of aliases (for nickname-history support).
// Members link directly to profiles (since we stopped exposing $users).
type DmMember = {
	id: string; // profile id
	userId?: string | null;
	nickname?: string | null;
};
type DmMessage = {
	author?: string | null;
	authorId?: string | null;
};
export type DmRoom = {
	name: string;
	members?: DmMember[] | null;
	messages?: DmMessage[] | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function dmOtherName(
	room: DmRoom | string,
	me: string | string[],
	myUserId?: string | null
): string {
	if (typeof room === 'string') {
		return legacyOther(room, me) ?? 'Deleted user';
	}

	if (myUserId && room.members && room.members.length > 0) {
		const other = room.members.find((p) => p.userId && p.userId !== myUserId);
		if (other?.nickname) return other.nickname;
	}

	// Fallback: last non-me message author. Author nicknames are snapshotted
	// on each message, so they survive even after the user is deleted.
	if (room.messages && room.messages.length > 0) {
		const meSet = aliasSet(me);
		for (let i = room.messages.length - 1; i >= 0; i--) {
			const author = room.messages[i].author;
			if (author && !meSet.has(author)) return author;
		}
	}

	const legacy = legacyOther(room.name, me);
	if (legacy) return legacy;
	return 'Deleted user';
}

function aliasSet(me: string | string[]): Set<string> {
	return Array.isArray(me) ? new Set(me) : new Set([me]);
}

// Find the other participant's userId for a DM. Prefers the participants link
// (live, survives renames) and falls back to the most recent non-me message
// authorId. Returns null if no other participant can be identified.
export function dmOtherUserId(room: DmRoom, myUserId: string | null | undefined): string | null {
	if (!myUserId) return null;
	const fromLink = (room.members ?? []).find((p) => p.userId && p.userId !== myUserId);
	if (fromLink?.userId) return fromLink.userId;
	const messages = room.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const aId = messages[i].authorId;
		if (aId && aId !== myUserId) return aId;
	}
	return null;
}

function legacyOther(roomName: string, me: string | string[]): string | null {
	const meSet = aliasSet(me);
	const parts = roomName.split('|');
	const candidate = parts.find((p) => !meSet.has(p));
	// New DMs use userId-keyed room.names — refuse to display a raw UUID.
	if (candidate && !UUID_RE.test(candidate)) return candidate;
	return null;
}

export function roomDisplayName(
	room: { name: string; kind?: string | null | undefined; members?: DmMember[] | null },
	me: string | string[],
	myUserId?: string | null
): string {
	if (room.kind === 'dm') return dmOtherName(room, me, myUserId);
	return room.name;
}

export function downloadUrl(src: string): string {
	return src.replace('/upload/', '/upload/fl_attachment/');
}

export function filenameFromUrl(url: string): string {
	try {
		const path = new URL(url).pathname;
		return path.split('/').pop() || 'download';
	} catch {
		return 'download';
	}
}

export async function downloadMedia(src: string): Promise<void> {
	try {
		const res = await fetch(downloadUrl(src));
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const blob = await res.blob();
		const blobUrl = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = blobUrl;
		a.download = filenameFromUrl(src);
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
	} catch (err) {
		console.error('Download failed', err);
	}
}

function snapshotPreview(source: CanvasImageSource, w: number, h: number): string | null {
	const targetMax = 160;
	const ratio = w / h;
	const tw = ratio >= 1 ? targetMax : Math.max(16, Math.round(targetMax * ratio));
	const th = ratio >= 1 ? Math.max(16, Math.round(targetMax / ratio)) : targetMax;
	const canvas = document.createElement('canvas');
	canvas.width = tw;
	canvas.height = th;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(source, 0, 0, tw, th);
	try {
		return canvas.toDataURL('image/jpeg', 0.75);
	} catch {
		return null;
	}
}

export type MediaMeta = { width: number; height: number; preview: string | null };

export async function readMediaMeta(file: File): Promise<MediaMeta | null> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		if (file.type.startsWith('video/')) {
			const v = document.createElement('video');
			v.preload = 'metadata';
			v.muted = true;
			v.playsInline = true;
			let resolved = false;
			const done = (meta: MediaMeta | null) => {
				if (resolved) return;
				resolved = true;
				URL.revokeObjectURL(url);
				resolve(meta);
			};
			v.onloadedmetadata = () => {
				v.currentTime = Math.min(0.1, (v.duration || 1) * 0.05);
			};
			v.onseeked = () => {
				const w = v.videoWidth;
				const h = v.videoHeight;
				if (!w || !h) return done(null);
				const preview = snapshotPreview(v, w, h);
				done({ width: w, height: h, preview });
			};
			v.onerror = () => done(null);
			v.src = url;
		} else {
			const img = new Image();
			img.onload = () => {
				const w = img.naturalWidth;
				const h = img.naturalHeight;
				URL.revokeObjectURL(url);
				if (!w || !h) return resolve(null);
				const preview = snapshotPreview(img, w, h);
				resolve({ width: w, height: h, preview });
			};
			img.onerror = () => {
				URL.revokeObjectURL(url);
				resolve(null);
			};
			img.src = url;
		}
	});
}

export const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'webm', 'mp4'] as const;
export const ALLOWED_ACCEPT = '.png,.jpg,.jpeg,.jfif,.webp,.gif,.webm,.mp4,image/*,video/*';
export const MAX_BYTES = 25 * 1024 * 1024;

export const CLOUDINARY_CLOUD = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME as string;
export const CLOUDINARY_PRESET = import.meta.env.VITE_CLOUDINARY_PRESET as string;

export type CloudinaryResp = {
	public_id: string;
	secure_url: string;
	width?: number;
	height?: number;
	format?: string;
	resource_type?: string;
	bytes?: number;
};

export function uploadToCloudinary(
	file: File,
	onProgress: (pct: number) => void
): { promise: Promise<CloudinaryResp>; abort: () => void } {
	const xhr = new XMLHttpRequest();
	const promise = new Promise<CloudinaryResp>((resolve, reject) => {
		xhr.upload.addEventListener('progress', (ev) => {
			if (ev.lengthComputable) {
				onProgress(Math.round((ev.loaded / ev.total) * 100));
			}
		});
		xhr.addEventListener('load', () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				try {
					resolve(JSON.parse(xhr.responseText));
				} catch (e) {
					reject(e instanceof Error ? e : new Error('Bad JSON from Cloudinary'));
				}
			} else {
				reject(
					new Error(
						`Cloudinary ${xhr.status}: ${(xhr.responseText || '').slice(0, 200) || '(empty)'}`
					)
				);
			}
		});
		xhr.addEventListener('error', () => reject(new Error('Network error')));
		xhr.addEventListener('abort', () => reject(new DOMException('Upload cancelled', 'AbortError')));
		const fd = new FormData();
		fd.append('file', file);
		fd.append('upload_preset', CLOUDINARY_PRESET);
		xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`);
		xhr.send(fd);
	});
	return { promise, abort: () => xhr.abort() };
}
