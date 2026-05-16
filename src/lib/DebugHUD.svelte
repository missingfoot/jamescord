<script lang="ts">
	import { onMount } from 'svelte';
	import { debug } from './debug.svelte';
	import { perfState, toggle, enableAll, disableAll, PERF_CATEGORIES } from './perf.svelte';

	let fps = $state(0);
	let memMB = $state(0);

	function formatBytes(b: number): string {
		if (b < 1024) return `${b} B`;
		if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
		return `${(b / 1024 / 1024).toFixed(2)} MB`;
	}

	onMount(() => {
		let frames = 0;
		let lastTime = performance.now();
		let rafId: number;

		function tick() {
			frames++;
			const now = performance.now();
			if (now - lastTime >= 500) {
				fps = Math.round((frames * 1000) / (now - lastTime));
				frames = 0;
				lastTime = now;
				const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
				if (mem) memMB = Math.round(mem.usedJSHeapSize / 1024 / 1024);
			}
			rafId = requestAnimationFrame(tick);
		}
		rafId = requestAnimationFrame(tick);

		const apiHosts = ['instantdb.com', 'instant-storage', '/instant-api'];
		const po = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				const e = entry as PerformanceResourceTiming;
				if (!apiHosts.some((h) => e.name.includes(h))) continue;
				debug.fetchCount++;
				const size = e.transferSize || 0;
				const decoded = e.decodedBodySize || 0;
				if (size === 0 && decoded > 0) {
					debug.bytesCache += decoded;
				} else {
					debug.bytesNet += size;
				}
			}
		});
		try {
			po.observe({ type: 'resource', buffered: true } as PerformanceObserverInit);
		} catch {
			po.observe({ entryTypes: ['resource'] });
		}

		return () => {
			cancelAnimationFrame(rafId);
			po.disconnect();
		};
	});

	function reset() {
		debug.bytesNet = 0;
		debug.bytesCache = 0;
		debug.fetchCount = 0;
	}
</script>

<div
	class="pointer-events-auto fixed right-3 bottom-3 z-50 w-60 select-none rounded-lg border border-white/10 bg-black/80 p-3 font-mono text-[11px] leading-relaxed text-white shadow-lg backdrop-blur-sm"
>
	<div class="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-white/60">
		<span>Debug HUD</span>
		<button
			type="button"
			onclick={reset}
			class="rounded bg-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/20"
		>
			Reset
		</button>
	</div>
	<div class="flex justify-between">
		<span class="text-white/60">FPS</span>
		<span class={fps < 50 ? 'text-amber-400' : 'text-emerald-400'}>{fps}</span>
	</div>
	{#if memMB > 0}
		<div class="flex justify-between">
			<span class="text-white/60">JS heap</span>
			<span>{memMB} MB</span>
		</div>
	{/if}
	<div class="my-1.5 border-t border-white/10"></div>
	<div class="flex justify-between">
		<span class="text-white/60">Groups</span>
		<span>{debug.groupsMounted}/{debug.groupsTotal}</span>
	</div>
	<div class="flex justify-between">
		<span class="text-white/60">Media in buffer</span>
		<span>{debug.mediaInBuffer}/{debug.mediaTotal}</span>
	</div>
	<div class="flex justify-between">
		<span class="text-white/60">Media loaded</span>
		<span>{debug.mediaLoaded}</span>
	</div>
	<div class="flex justify-between">
		<span class="text-white/60">Videos active</span>
		<span>{debug.videosActive}</span>
	</div>
	<div class="my-1.5 border-t border-white/10"></div>
	<div class="flex justify-between">
		<span class="text-white/60">Net</span>
		<span class="text-rose-300">{formatBytes(debug.bytesNet)}</span>
	</div>
	<div class="flex justify-between">
		<span class="text-white/60">Cache</span>
		<span class="text-emerald-300">{formatBytes(debug.bytesCache)}</span>
	</div>
	<div class="flex justify-between">
		<span class="text-white/60">Fetches</span>
		<span>{debug.fetchCount}</span>
	</div>
	<div class="my-1.5 border-t border-white/10"></div>
	<div class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-white/60">
		<span>Console logs</span>
		<div class="flex gap-1">
			<button
				type="button"
				onclick={enableAll}
				class="rounded bg-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/20"
			>
				All
			</button>
			<button
				type="button"
				onclick={disableAll}
				class="rounded bg-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/20"
			>
				None
			</button>
		</div>
	</div>
	<div class="flex flex-wrap gap-1">
		{#each PERF_CATEGORIES as cat (cat)}
			{@const on = perfState.enabled.has(cat)}
			<button
				type="button"
				onclick={() => toggle(cat)}
				class="rounded px-1.5 py-0.5 text-[10px] {on
					? 'bg-emerald-500/30 text-emerald-200'
					: 'bg-white/10 text-white/60 hover:bg-white/20'}"
			>
				{cat}
			</button>
		{/each}
	</div>
</div>
