export const PERF_CATEGORIES = [
	'groups',
	'media',
	'scroll',
	'video',
	'network'
] as const;

export type PerfCategory = (typeof PERF_CATEGORIES)[number];

const STORAGE_KEY = 'chat:perfCategories';

const COLORS: Record<PerfCategory, string> = {
	groups: '#a78bfa',
	media: '#34d399',
	scroll: '#60a5fa',
	video: '#fbbf24',
	network: '#f472b6'
};

function loadInitial(): Set<PerfCategory> {
	if (typeof window === 'undefined') return new Set();
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return new Set();
		const arr = JSON.parse(raw) as string[];
		return new Set(arr.filter((c): c is PerfCategory => PERF_CATEGORIES.includes(c as PerfCategory)));
	} catch {
		return new Set();
	}
}

export const perfState = $state({
	enabled: loadInitial()
});

function persist() {
	if (typeof window === 'undefined') return;
	window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(perfState.enabled)));
}

export function isEnabled(cat: PerfCategory): boolean {
	return perfState.enabled.has(cat);
}

export function plog(cat: PerfCategory, msg: string, data?: unknown) {
	if (!perfState.enabled.has(cat)) return;
	const color = COLORS[cat];
	const prefix = `%c[${cat}]%c ${msg}`;
	const styleA = `color:${color};font-weight:bold`;
	const styleB = 'color:inherit';
	if (data !== undefined) {
		// eslint-disable-next-line no-console
		console.log(prefix, styleA, styleB, data);
	} else {
		// eslint-disable-next-line no-console
		console.log(prefix, styleA, styleB);
	}
}

export function enable(cat: PerfCategory) {
	perfState.enabled.add(cat);
	perfState.enabled = new Set(perfState.enabled);
	persist();
}

export function disable(cat: PerfCategory) {
	perfState.enabled.delete(cat);
	perfState.enabled = new Set(perfState.enabled);
	persist();
}

export function toggle(cat: PerfCategory) {
	if (perfState.enabled.has(cat)) disable(cat);
	else enable(cat);
}

export function enableAll() {
	PERF_CATEGORIES.forEach((c) => perfState.enabled.add(c));
	perfState.enabled = new Set(perfState.enabled);
	persist();
}

export function disableAll() {
	perfState.enabled.clear();
	perfState.enabled = new Set(perfState.enabled);
	persist();
}

if (typeof window !== 'undefined') {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window as any).perf = {
		enable,
		disable,
		toggle,
		on: enableAll,
		off: disableAll,
		state: perfState,
		categories: PERF_CATEGORIES
	};
}
