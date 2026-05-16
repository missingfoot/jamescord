<script lang="ts">
	import { onMount, getContext } from 'svelte';
	import { Play, ImageIcon } from '$lib/icons';
	import {
		trackMediaMount,
		setMediaInBuffer,
		setMediaLoaded,
		setVideoActive
	} from './debug.svelte';
	import { plog } from './perf.svelte';

	let {
		src,
		type,
		width,
		height,
		preview,
		alt = '',
		href,
		fileId,
		farMargin = 700
	}: {
		src: string;
		type: 'image' | 'video';
		width?: number;
		height?: number;
		preview?: string;
		alt?: string;
		href?: string;
		fileId?: string;
		farMargin?: number;
	} = $props();

	const scrollDir = getContext<() => 'up' | 'down' | 'idle'>('scrollDir');
	const scrollSpeed = getContext<() => 'slow' | 'fast'>('scrollSpeed');
	const mediaAutoload = getContext<() => 'all' | 'images' | 'none'>('mediaAutoload');
	const onMediaReadyCtx = getContext<((fileId: string) => void) | undefined>('onMediaReady');
	const openLightbox = getContext<
		| ((m: {
				id: string;
				src: string;
				type: 'image' | 'video';
				width?: number;
				height?: number;
				alt?: string;
		  }) => void)
		| undefined
	>('openLightbox');

	function expand() {
		if (!fullLoaded || !openLightbox || !fileId) return;
		openLightbox({ id: fileId, src, type, width, height, alt });
	}

	let imgEl: HTMLImageElement | undefined = $state();
	let videoEl: HTMLVideoElement | undefined = $state();
	let wrapperEl: HTMLElement | undefined = $state();
	let farVisible = $state(false);
	let rowHovered = $state(false);
	let fullLoaded = $state(false);
	let deblurred = $state(false);
	let tabVisible = $state(
		typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
	);
	let userLoaded = $state(false);

	const autoloadMode = $derived(mediaAutoload?.() ?? 'all');
	const allowed = $derived(
		autoloadMode === 'all' ||
			(autoloadMode === 'images' && type === 'image') ||
			userLoaded
	);

	const hasDims = $derived(!!(width && height));
	const hasPlaceholder = $derived(hasDims && !!preview);
	const wrapStyle = $derived(
		hasDims
			? `aspect-ratio: ${width} / ${height}; width: min(100%, 28rem, calc(20rem * ${width} / ${height}), ${width}px);`
			: ''
	);

	function rootMarginFor(dir: 'up' | 'down' | 'idle', size: number): string {
		const small = Math.max(80, Math.round(size * 0.2));
		if (dir === 'down') return `${small}px 0px ${size}px 0px`;
		if (dir === 'up') return `${size}px 0px ${small}px 0px`;
		const sym = Math.round(size * 0.6);
		return `${sym}px 0px ${sym}px 0px`;
	}

	function onLoadedMetadata() {
		// Force the first frame to render so the paused video acts as its own poster.
		// preload="metadata" alone is unreliable across browsers; seeking nudges decode.
		if (videoEl && videoEl.readyState < 2) {
			try {
				videoEl.currentTime = 0.001;
			} catch {}
		}
	}

	function onMediaReady() {
		fullLoaded = true;
		plog('media', `ready (${type})`, { src: shortName(src) });
		if (fileId) onMediaReadyCtx?.(fileId);
		// Mount full-res blurred first, then on the next paint flip to unblurred so the
		// transition animates the high-res image (not the tiny preview).
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				deblurred = true;
			});
		});
	}

	function shortName(u: string | undefined | null): string {
		if (!u) return '';
		try {
			const path = new URL(u).pathname;
			return path.split('/').slice(-1)[0] || path;
		} catch {
			return u.slice(-32);
		}
	}

	// Preload the full image for the blur-up swap.
	$effect(() => {
		if (type !== 'image' || !allowed || !src) return;
		if (fullLoaded) return;
		const probe = new Image();
		probe.onload = onMediaReady;
		probe.src = src;
		return () => {
			probe.onload = null;
		};
	});

	onMount(() => {
		const releaseMount = trackMediaMount();
		plog('media', `mount ${type}`, { src: shortName(src) });
		let inBuffer = false;
		let isLoaded = false;
		let isVideoActive = false;
		const node = (videoEl ?? imgEl ?? wrapperEl) as HTMLElement | undefined;
		if (!node) return releaseMount;
		const root = node.closest('[data-scroll-root]') as HTMLElement | null;

		const onVisChange = () => {
			tabVisible = document.visibilityState === 'visible';
		};
		document.addEventListener('visibilitychange', onVisChange);

		const rowEl =
			type === 'video' ? (node.closest('[data-msg-id]') as HTMLElement | null) : null;
		const onRowEnter = () => (rowHovered = true);
		const onRowLeave = () => (rowHovered = false);
		if (rowEl) {
			rowEl.addEventListener('mouseenter', onRowEnter);
			rowEl.addEventListener('mouseleave', onRowLeave);
		}

		$effect.root(() => {
			$effect(() => {
				if (farVisible !== inBuffer) {
					setMediaInBuffer(farVisible);
					plog('media', `${farVisible ? 'enter' : 'leave'} buffer (${type})`, {
						src: shortName(src)
					});
					inBuffer = farVisible;
				}
			});
			$effect(() => {
				if (fullLoaded !== isLoaded) {
					setMediaLoaded(fullLoaded);
					isLoaded = fullLoaded;
				}
			});
			$effect(() => {
				if (type !== 'video') return;
				const active = farVisible && rowHovered && tabVisible && fullLoaded;
				if (active !== isVideoActive) {
					setVideoActive(active);
					plog('video', `${active ? 'play' : 'pause'}`, { src: shortName(src) });
					isVideoActive = active;
				}
			});
		});

		let far: IntersectionObserver | null = null;
		let lastDir: 'up' | 'down' | 'idle' = 'idle';

		let lastSpeed: 'slow' | 'fast' = 'slow';

		function rebuildFar(dir: 'up' | 'down' | 'idle', speed: 'slow' | 'fast') {
			lastDir = dir;
			lastSpeed = speed;
			const size = speed === 'fast' ? Math.round(farMargin * 1.8) : farMargin;
			far?.disconnect();
			far = new IntersectionObserver(
				(entries) => {
					farVisible = entries[0]?.isIntersecting ?? false;
				},
				{ root, rootMargin: rootMarginFor(dir, size) }
			);
			if (node) far.observe(node);
		}

		rebuildFar(scrollDir?.() ?? 'idle', scrollSpeed?.() ?? 'slow');

		const interval = window.setInterval(() => {
			const d = scrollDir?.() ?? 'idle';
			const s = scrollSpeed?.() ?? 'slow';
			if (d !== lastDir || s !== lastSpeed) rebuildFar(d, s);
		}, 200);

		return () => {
			far?.disconnect();
			window.clearInterval(interval);
			document.removeEventListener('visibilitychange', onVisChange);
			if (rowEl) {
				rowEl.removeEventListener('mouseenter', onRowEnter);
				rowEl.removeEventListener('mouseleave', onRowLeave);
			}
			if (inBuffer) setMediaInBuffer(false);
			if (isLoaded) setMediaLoaded(false);
			if (isVideoActive) setVideoActive(false);
			plog('media', `unmount ${type}`, { src: shortName(src) });
			releaseMount();
		};
	});

	$effect(() => {
		if (!farVisible && type === 'video') {
			fullLoaded = false;
			deblurred = false;
		}
	});

	$effect(() => {
		if (type === 'video' && videoEl) {
			if (farVisible) {
				if (videoEl.getAttribute('src') !== src) {
					videoEl.src = src;
					plog('video', 'src set', { src: shortName(src) });
				}
				if (rowHovered && tabVisible) {
					videoEl.play().catch(() => {});
				} else {
					videoEl.pause();
				}
			} else if (videoEl.getAttribute('src')) {
				videoEl.pause();
				videoEl.removeAttribute('src');
				videoEl.load();
				plog('video', 'src unloaded', { src: shortName(src) });
			}
		}
	});
</script>

{#if hasPlaceholder}
	<div
		bind:this={wrapperEl}
		style={wrapStyle}
		class="relative overflow-hidden rounded-lg [transform:translateZ(0)] [backface-visibility:hidden]"
	>
		{#if !fullLoaded}
			<img
				src={preview}
				alt=""
				aria-hidden="true"
				class="pointer-events-none absolute inset-0 h-full w-full object-cover scale-110 blur-xl"
			/>
		{/if}
		{#if allowed}
			{#if type === 'image' && fullLoaded}
				<button
					type="button"
					onclick={expand}
					aria-label="Open image"
					class="absolute inset-0 block h-full w-full cursor-zoom-in"
				>
					<img
						bind:this={imgEl}
						{src}
						{alt}
						decoding="async"
						class="block h-full w-full object-cover transition-[filter,transform] duration-500 {deblurred
							? 'scale-100 blur-0'
							: 'scale-110 blur-xl'}"
					/>
				</button>
			{:else if type === 'video'}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					bind:this={videoEl}
					loop
					muted
					playsinline
					preload="metadata"
					onloadedmetadata={onLoadedMetadata}
					onloadeddata={onMediaReady}
					onclick={expand}
					class="absolute inset-0 h-full w-full cursor-zoom-in object-cover transition-[filter,transform] duration-500 {fullLoaded && deblurred
						? 'scale-100 blur-0'
						: 'scale-110 blur-xl opacity-0'} {fullLoaded ? 'opacity-100' : ''}"
				></video>
			{/if}
		{:else}
			<button
				type="button"
				onclick={() => (userLoaded = true)}
				aria-label={type === 'video' ? 'Load video' : 'Load image'}
				class="group absolute inset-0 flex items-center justify-center bg-black/15 hover:bg-black/25 transition-colors"
			>
				<div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white group-hover:bg-black/75 group-hover:scale-105 transition-transform">
					{#if type === 'video'}
						<Play size={22} class="ml-0.5" fill="currentColor" />
					{:else}
						<ImageIcon size={20} />
					{/if}
				</div>
			</button>
		{/if}
	</div>
{:else if !allowed}
	<button
		type="button"
		onclick={() => (userLoaded = true)}
		class="flex items-center gap-2 rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
	>
		{#if type === 'video'}
			<Play size={14} class="ml-0.5" fill="currentColor" />
			Load video
		{:else}
			<ImageIcon size={14} />
			Load image
		{/if}
	</button>
{:else if type === 'video'}
	<!-- svelte-ignore a11y_media_has_caption -->
	<video
		bind:this={videoEl}
		loop
		muted
		playsinline
		preload="metadata"
		onloadedmetadata={onLoadedMetadata}
		onloadeddata={onMediaReady}
		class="max-h-80 max-w-md rounded-lg"
	></video>
{:else if href}
	<a href={href} target="_blank" rel="noopener noreferrer" class="inline-block">
		<img
			bind:this={imgEl}
			{src}
			{alt}
			onload={onMediaReady}
			loading="lazy"
			decoding="async"
			class="max-h-80 max-w-md rounded-lg"
		/>
	</a>
{:else}
	<img
		bind:this={imgEl}
		{src}
		{alt}
		onload={onMediaReady}
		loading="lazy"
		decoding="async"
		class="max-h-80 max-w-md rounded-lg"
	/>
{/if}
