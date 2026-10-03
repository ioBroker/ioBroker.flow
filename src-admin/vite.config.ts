// @ts-expect-error no types
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The admin tab.
 *
 * An ordinary single-page app, not a federation remote: admin shows an adapter tab in an iframe that
 * loads `adapter/flow/tab.html`, so there is no host to share modules with.
 *
 * `assetsDir: 'tab-assets'` keeps its chunks in their own folder under `admin/`, next to the device
 * manager plugin in `admin/dm-widgets/`. Both builds wipe their destination before they copy, and
 * with a folder each they cannot wipe each other's files.
 */
const packages = fileURLToPath(new URL('../packages', import.meta.url));

const config = {
    plugins: [react()],
    resolve: {
        alias: {
            '@flow/core': `${packages}/core/src/index.ts`,
            '@flow/editor': `${packages}/editor/src/index.ts`,
            '@flow/i18n': `${packages}/translations/src/index.ts`,
        },
        dedupe: ['react', 'react-dom', '@emotion/react', '@mui/material', '@mui/system', '@mui/icons-material'],
    },
    server: {
        port: 3000,
        fs: { allow: ['..'] },
        // The dev server talks to a running admin for the socket and the adapter files
        proxy: {
            '/adapter': 'http://localhost:8081',
            '/lib': 'http://localhost:8081',
            '/files': 'http://localhost:8081',
        },
    },
    base: './',
    build: {
        target: 'chrome89',
        outDir: './build',
        assetsDir: 'tab-assets',
        rollupOptions: {
            onwarn(warning: { code: string }, warn: (warning: { code: string }) => void): void {
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                    return;
                }
                warn(warning);
            },
        },
    },
};

export default config;
