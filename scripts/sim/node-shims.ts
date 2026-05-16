// Adapters so @instantdb/core can run in Node. The package defaults
// (IndexedDBStorage, WindowNetworkListener) both assume a browser environment.

// Make the Reactor's isClient() check return true. Without this, the Reactor
// constructor early-returns and leaves querySubs/kv undefined, breaking every
// subsequent subscribeQuery / transact call. This must run BEFORE @instantdb/core
// is imported.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
	(globalThis as { window?: unknown }).window = globalThis;
}

import { StoreInterface } from '@instantdb/core';

// Mirrors @instantdb/core's internal InMemoryStorage (not exported via package
// exports, so we re-implement it here).
export class NodeInMemoryStore extends StoreInterface {
	private store = new Map<string, unknown>();

	constructor(appId: string, dbName: string) {
		super(appId, dbName as never);
	}

	async getItem(k: string): Promise<unknown> {
		return this.store.get(k) ?? null;
	}

	async setItem(k: string, v: unknown): Promise<void> {
		this.store.set(k, v);
	}

	async getAllKeys(): Promise<string[]> {
		return [...this.store.keys()];
	}

	async multiSet(pairs: Array<[string, unknown]>): Promise<void> {
		for (const [k, v] of pairs) this.store.set(k, v);
	}

	async removeItem(k: string): Promise<void> {
		this.store.delete(k);
	}
}

// In Node we assume the network is always up. The sim is short-lived and
// running on a dev machine; if connectivity drops, the next transact/sub fails
// loudly which is fine.
export class AlwaysOnlineNetworkListener {
	static async getIsOnline(): Promise<boolean> {
		return true;
	}
	static listen(_: (online: boolean) => void): () => void {
		return () => {};
	}
}
