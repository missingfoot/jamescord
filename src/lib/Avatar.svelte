<script lang="ts">
	// One avatar component to rule them all. If a userId is passed in and that
	// user no longer exists (via the `knownUserIds` context provided in
	// +page.svelte), the avatar swaps to the ghost glyph — same color block,
	// just a translucent ghost where the initials would be.
	import { getContext } from 'svelte';
	import { avatarColor, initials } from './avatar';
	import GhostAvatar from './GhostAvatar.svelte';

	let {
		nickname,
		userId = null,
		size = 36,
		rounded = 'rounded-md',
		textSize = 'text-xs',
		grayscale = false
	}: {
		nickname: string;
		userId?: string | null;
		size?: number;
		rounded?: string;
		textSize?: string;
		grayscale?: boolean;
	} = $props();

	const getKnownUserIds = getContext<(() => Set<string>) | undefined>('knownUserIds');
	const isDeleted = $derived.by(() => {
		if (!userId) return false;
		const ids = getKnownUserIds?.() ?? new Set<string>();
		return !ids.has(userId);
	});
	// Ghost icon at ~62% of the avatar size — visually matches what we picked
	// by hand for the earlier ghost sizes.
	const ghostPx = $derived(Math.round(size * 0.62));
</script>

<div
	style="width: {size}px; height: {size}px;"
	class="flex shrink-0 items-center justify-center font-semibold text-white {rounded} {textSize} {avatarColor(
		nickname
	)} {grayscale ? 'grayscale' : ''}"
	aria-hidden="true"
>
	{#if isDeleted}
		<GhostAvatar size={ghostPx} />
	{:else}
		{initials(nickname)}
	{/if}
</div>
