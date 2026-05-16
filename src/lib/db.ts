import { init } from '@instantdb/svelte';
import schema from '../../instant.schema';

const apiURI =
	import.meta.env.DEV && typeof window !== 'undefined' ? `${window.location.origin}/instant-api` : undefined;

export const db = init({
	appId: import.meta.env.VITE_INSTANT_APP_ID!,
	schema,
	useDateObjects: true,
	...(apiURI ? { apiURI } : {})
});
