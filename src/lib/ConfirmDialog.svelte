<script lang="ts">
	import { tick, onMount } from 'svelte';
	import { fly, fade } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { dialog, respond } from './confirm.svelte';

	let confirmBtn: HTMLButtonElement | undefined = $state();

	// Focus the confirm button when a dialog opens, for keyboard-only operation.
	$effect(() => {
		if (dialog.request) {
			tick().then(() => confirmBtn?.focus());
		}
	});

	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!dialog.request) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				respond(false);
			} else if (e.key === 'Enter') {
				e.preventDefault();
				respond(true);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

{#if dialog.request}
	{@const opts = dialog.request.options}
	{@const confirmLabel = opts.confirmLabel ?? 'Confirm'}
	{@const cancelLabel = opts.cancelLabel ?? 'Cancel'}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		role="presentation"
		class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 max-md:items-end max-md:p-0"
		onclick={() => respond(false)}
		transition:fade={{ duration: 120 }}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-label={opts.title}
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			class="w-full max-w-sm overflow-hidden rounded-2xl border border-black/5 bg-white shadow-xl dark:border-white/10 dark:bg-neutral-900 max-md:max-w-none max-md:rounded-t-2xl max-md:rounded-b-none max-md:border-b-0"
			in:fly={{ y: 8, duration: 160, easing: cubicOut }}
			out:fade={{ duration: 100 }}
		>
			<div class="px-5 pt-5 pb-3">
				<h2 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">{opts.title}</h2>
				{#if opts.body}
					<p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{opts.body}</p>
				{/if}
			</div>
			<div
				class="flex items-center justify-end gap-2 border-t border-neutral-100 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/40"
			>
				{#if !opts.hideCancel}
					<button
						type="button"
						onclick={() => respond(false)}
						class="rounded-md px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
					>
						{cancelLabel}
					</button>
				{/if}
				<button
					bind:this={confirmBtn}
					type="button"
					onclick={() => respond(true)}
					class="rounded-md px-3 py-1.5 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-neutral-900 {opts.destructive
						? 'bg-rose-600 hover:bg-rose-700 focus:ring-rose-500 dark:bg-rose-500 dark:hover:bg-rose-400'
						: 'bg-accent-600 hover:bg-accent-700 focus:ring-accent-500 dark:bg-accent-500 dark:hover:bg-accent-400'}"
				>
					{confirmLabel}
				</button>
			</div>
		</div>
	</div>
{/if}
