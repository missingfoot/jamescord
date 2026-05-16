// Promise-based replacement for window.confirm — see ConfirmDialog.svelte.

export type ConfirmOptions = {
	title: string;
	body?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** When true, the dialog only shows a confirm button (alert-style). */
	hideCancel?: boolean;
	destructive?: boolean;
};

type Request = {
	options: ConfirmOptions;
	resolve: (value: boolean) => void;
};

// Holder object so the property mutation is reactive across modules.
export const dialog = $state<{ request: Request | null }>({ request: null });

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
	// If another dialog is somehow still open, resolve it as cancelled first
	// so the previous caller's promise doesn't hang.
	if (dialog.request) dialog.request.resolve(false);
	return new Promise((resolve) => {
		dialog.request = { options, resolve };
	});
}

export function respond(value: boolean) {
	const current = dialog.request;
	if (!current) return;
	dialog.request = null;
	current.resolve(value);
}
