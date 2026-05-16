const PALETTE = [
	'bg-rose-500',
	'bg-orange-500',
	'bg-amber-500',
	'bg-lime-500',
	'bg-emerald-500',
	'bg-teal-500',
	'bg-cyan-500',
	'bg-sky-500',
	'bg-blue-500',
	'bg-violet-500',
	'bg-fuchsia-500',
	'bg-pink-500'
];

export function avatarColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return PALETTE[h % PALETTE.length];
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}
