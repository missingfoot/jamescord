<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { trackGroupMount, setGroupInWindow } from './debug.svelte';
	import { plog } from './perf.svelte';

	let {
		children,
		groupId,
		bufferPx = 1500
	}: { children: Snippet; groupId: string; bufferPx?: number } = $props();

	let el: HTMLLIElement | undefined = $state();
	let inWindow = $state(true);
	let measuredHeight = $state(0);

	onMount(() => {
		const releaseMount = trackGroupMount();
		setGroupInWindow(true);
		plog('groups', `mount ${groupId}`);
		let lastInWindow = true;
		if (!el) return releaseMount;
		const root = el.closest('[data-scroll-root]') as HTMLElement | null;

		const io = new IntersectionObserver(
			(entries) => {
				const e = entries[0];
				if (e) {
					inWindow = e.isIntersecting;
					if (inWindow !== lastInWindow) {
						setGroupInWindow(inWindow);
						plog(
							'groups',
							`${inWindow ? 'enter' : 'leave'} window ${groupId}`,
							inWindow ? undefined : { savedHeight: measuredHeight }
						);
						lastInWindow = inWindow;
					}
				}
			},
			{ root, rootMargin: `${bufferPx}px 0px ${bufferPx}px 0px` }
		);
		io.observe(el);

		const ro = new ResizeObserver((entries) => {
			const h = entries[0]?.contentRect.height ?? 0;
			if (h > 0 && inWindow) measuredHeight = h;
		});
		ro.observe(el);

		return () => {
			io.disconnect();
			ro.disconnect();
			if (lastInWindow) setGroupInWindow(false);
			plog('groups', `unmount ${groupId}`);
			releaseMount();
		};
	});
</script>

<li
	bind:this={el}
	data-group-id={groupId}
	style={inWindow || !measuredHeight ? '' : `height: ${measuredHeight}px`}
>
	{#if inWindow}
		{@render children()}
	{/if}
</li>
