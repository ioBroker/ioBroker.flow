// @ts-expect-error no types
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { moduleFederationShared } from '@iobroker/types-vis-2/modulefederation.vis.config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The shared modules come from `@iobroker/types-vis-2`, so the bundle always uses the copies vis-2
 * provides: react, react-dom, the JSX runtime, `@emotion/react`, `@mui/material`, `@mui/system` and
 * `@mui/private-theming` as singletons, filtered down to what this package.json really depends on.
 *
 * `react/jsx-runtime` is the entry that matters most: a widget set that bundles its own copy creates
 * its elements with the element symbol of *its* react version, and since react 19 renamed that symbol,
 * a vis-2 on react 19 rejects such a set outright instead of loading it. Never replace this call with
 * a hand-written list.
 *
 * `@iobroker/gui-components` is deliberately not in that list (vis-2 does not share it), so the state
 * picker and the colour picker are bundled here. They are only reachable through the designer, which
 * `DiagramField.tsx` loads as a lazy chunk -- so a view that only *shows* diagrams never downloads it.
 */
const pack = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** The shared sources live outside this package and are compiled into the bundle, not linked */
const packages = fileURLToPath(new URL('../packages', import.meta.url));

const config = {
    plugins: [
        federation({
            manifest: true,
            name: 'flowWidgets',
            filename: 'customWidgets.js',
            exposes: {
                './Flow': './src/Flow',
                './translations': './src/translations',
            },
            remotes: {},
            shared: moduleFederationShared(pack),
            dts: false,
        }),
        react(),
    ],
    resolve: {
        alias: {
            '@flow/core': `${packages}/core/src/index.ts`,
            '@flow/editor': `${packages}/editor/src/index.ts`,
            '@flow/i18n': `${packages}/translations/src/index.ts`,
        },
        // The fallback copies inside the bundle must be unique too, or MUI ends up with two themes
        dedupe: ['react', 'react-dom', '@emotion/react', '@mui/material', '@mui/system', '@mui/icons-material'],
    },
    server: {
        port: 4173,
        // The shared sources are outside the Vite root, so the dev server has to be allowed to read them
        fs: { allow: ['..'] },
        proxy: {
            '/_socket': 'http://localhost:8082',
            '/vis.0': 'http://localhost:8082',
            '/adapter': 'http://localhost:8082',
            '/vis': 'http://localhost:8082',
            '/widgets': 'http://localhost:8082/vis',
            '/widgets.html': 'http://localhost:8082/vis',
            '/web': 'http://localhost:8082',
            '/state': 'http://localhost:8082',
        },
    },
    base: './',
    build: {
        // Module federation emits a top-level await in the remote entry. Chrome 89 (March 2021) is the
        // first version that runs it natively, which is also what the official vis-2 widget template
        // targets. `vite-plugin-top-level-await` would lower it for older browsers, but it drives the
        // printer of @swc/core and is broken against the current one, so the plugin is not worth the
        // two Android WebView releases it would buy back.
        target: 'chrome89',
        outDir: './build',
        rollupOptions: {
            onwarn(warning: { code: string }, warn: (warning: { code: string }) => void): void {
                // Suppress "Module level directives cause errors when bundled" warnings
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                    return;
                }
                warn(warning);
            },
        },
    },
};

export default config;
