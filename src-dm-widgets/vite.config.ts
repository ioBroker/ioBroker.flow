// @ts-expect-error no types
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore the package ships a plain .js config helper without types
import { moduleFederationShared } from '@iobroker/dm-widgets/modulefederation.devices.config.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hostShim } from './hostShim';

/**
 * The device manager plugin bundle.
 *
 * Three things here are fixed by the host and must not be renamed:
 *
 * - `filename: 'customDevices.js'` is the default `common.deviceWidgets.url` and the file name
 *   `io-package.json` declares. `tasks.ts` copies the output to `admin/dm-widgets/`, which is where
 *   `pluginLoader.ts` of ioBroker.devices looks for it.
 * - `./Components` is the only entry that loader knows: it imports that module and picks the widget
 *   out of its default export by the name from `common.deviceWidgets.components[].name`.
 * - `./translations` is loaded right before it and handed to `I18n.extendTranslations`.
 *
 * `./Config` is ours: the designer, reached from the widget's settings dialog as a `jsonConfig`
 * component of type `custom`. See `FlowDm.getConfigSchema()` for the other half of that contract.
 *
 * `manifest: true` is not optional either. `@iobroker/json-config` fetches `mf-manifest.json` next to
 * the entry and refuses to load a custom component whose manifest shares
 * `@iobroker/adapter-react-v5` instead of `@iobroker/gui-components` -- that is its check for a
 * component built against React 18 / MUI 6.
 */
const pack = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Which modules are federation singletons.
 *
 * `moduleFederationShared` returns everything the device manager is willing to share that this
 * package.json also depends on, and a shared entry is bundled **as a whole namespace** -- rolldown
 * cannot tree-shake something it has to hand over complete. Left as it comes, that put 6.5 MB of
 * fallback copies into the published adapter that the host never fetches, because the host provides
 * all of them: `@mui/icons-material` alone was 4.3 MB for the dozen icons this bundle uses.
 *
 * So only what genuinely breaks as a second copy stays shared:
 *
 * - `react`, `react-dom` and the JSX runtime -- two Reacts mean two context registries.
 * - `@mui/material` -- it carries the ThemeContext the host's theme arrives in.
 * - `@iobroker/dm-widgets` -- the bridge to the host's real `WidgetGeneric`; a second copy would be
 *   the compile-time stub, which renders nothing.
 *
 * `@emotion/react` is deliberately **not** shared. The device manager shares nothing itself, so with
 * `loaded-first` the copy we got was whichever another widget plugin registered first -- and that
 * copy imports *its* plugin's React. Emotion's `withEmotionCache` then called `useContext` on a React
 * that was not rendering, and the settings dialog died with `Cannot read properties of null (reading
 * 'useContext')` as soon as e.g. the NMEA or WitMotion widgets were on the page. Bundled, emotion
 * imports `react` like our own code does, through `hostShim.ts`, and gets the host's.
 *
 * The rest is bundled and tree-shaken. Icons are stateless SVG components, and `I18n` from
 * `@iobroker/gui-components` keeps its dictionary and language on `window`, so both copies read the
 * same data. `@emotion/styled` is left out for the reason vis-2 documents in its own shared list:
 * prebundled by `@module-federation/vite` it reaches `@mui/system` with the wrong interop shape and
 * MUI 9 dies while building its `Box`.
 */
const SINGLETONS = [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    '@mui/material',
    '@iobroker/dm-widgets',
];

function shared(): Record<string, unknown> {
    const all = moduleFederationShared(pack) as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const name of Object.keys(all)) {
        if (SINGLETONS.includes(name)) {
            result[name] = all[name];
        }
    }
    return result;
}

/** The shared sources live outside this package and are compiled into the bundle, not linked */
const packages = fileURLToPath(new URL('../packages', import.meta.url));

const config = {
    plugins: [
        // Before everything else: React and MUI have to come from the host, see `hostShim.ts`
        hostShim(),
        federation({
            manifest: true,
            name: 'flowDevices',
            filename: 'customDevices.js',
            exposes: {
                './Components': './src/Components',
                './Config': './src/Config',
                './translations': './src/translations',
            },
            remotes: {},
            shared: shared(),
            dts: false,
            shareStrategy: 'loaded-first',
        }),
        react(),
    ],
    resolve: {
        alias: {
            '@flow/core': `${packages}/core/src/index.ts`,
            '@flow/editor': `${packages}/editor/src/index.ts`,
            '@flow/i18n': `${packages}/translations/src/index.ts`,
        },
        dedupe: ['react', 'react-dom', '@emotion/react', '@mui/material', '@mui/system', '@mui/icons-material'],
    },
    server: {
        port: 4174,
        // The shared sources are outside the Vite root, so the dev server has to be allowed to read them
        fs: { allow: ['..'] },
    },
    base: './',
    build: {
        // Module federation emits a top-level await in the remote entry; Chrome 89 is the first
        // version that runs it natively. The device manager is an admin tab, so this is well below
        // what the admin itself requires anyway.
        target: 'chrome89',
        outDir: './build',
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
