import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		proxy: {
			'/instant-api': {
				target: 'https://api.instantdb.com',
				changeOrigin: true,
				secure: true,
				rewrite: (path) => path.replace(/^\/instant-api/, ''),
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				configure: (proxy: any) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					proxy.on('proxyReq', (proxyReq: any, req: any) => {
						proxyReq.removeHeader('origin');
						proxyReq.removeHeader('referer');
						if (req.url?.includes('/storage/upload')) {
							const ct = req.headers?.['content-type'] || '(none)';
							const cl = req.headers?.['content-length'] || '(none)';
							console.log(
								`[instant-api proxy] -> PUT ${req.url} content-type=${ct} length=${cl}`
							);
						}
					});
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					proxy.on('proxyRes', (proxyRes: any, req: any) => {
						if (!proxyRes.statusCode || proxyRes.statusCode < 400) return;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const chunks: any[] = [];
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						proxyRes.on('data', (c: any) => chunks.push(c));
						proxyRes.on('end', () => {
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const B = (globalThis as any).Buffer;
							const body = B
								? B.concat(chunks).toString('utf8').slice(0, 500)
								: '(buffer unavailable)';
							console.warn(
								`[instant-api proxy] ${req.method} ${req.url} -> ${proxyRes.statusCode}\n  body: ${body || '(empty)'}`
							);
						});
					});
				}
			}
		}
	}
});
