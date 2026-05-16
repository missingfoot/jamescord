export const debug = $state({
	groupsTotal: 0,
	groupsMounted: 0,
	mediaTotal: 0,
	mediaInBuffer: 0,
	mediaLoaded: 0,
	videosActive: 0,
	bytesNet: 0,
	bytesCache: 0,
	fetchCount: 0
});

export function trackGroupMount() {
	debug.groupsTotal++;
	return () => {
		debug.groupsTotal--;
	};
}

export function setGroupInWindow(v: boolean) {
	debug.groupsMounted += v ? 1 : -1;
}

export function trackMediaMount() {
	debug.mediaTotal++;
	return () => {
		debug.mediaTotal--;
	};
}

export function setMediaInBuffer(v: boolean) {
	debug.mediaInBuffer += v ? 1 : -1;
}

export function setMediaLoaded(v: boolean) {
	debug.mediaLoaded += v ? 1 : -1;
}

export function setVideoActive(v: boolean) {
	debug.videosActive += v ? 1 : -1;
}
