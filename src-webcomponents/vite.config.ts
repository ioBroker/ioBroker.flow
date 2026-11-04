// @ts-expect-error no types
import react from '@vitejs/plugin-react';
import { checkManifest, REACT_19_URL, REACT_SPECIFIERS, type WebComponentText } from '@iobroker/web-components';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

import { buildManifest, MANIFEST_FILE, MANIFEST_WORDS, TAG } from './manifest';

/**
 * The web component: one ES module, `admin/webcomponents/flow-diagram.js`, and its manifest
 * `flow-diagram.json` next to it, which every host reads from `/adapter/flow/` -- vis-2, the device
 * manager, Aura, admin. No module federation: the host shares nothing but the socket.
 *
 * React is not bundled. The four React imports point at `/lib/esm/react-19.js`, which web and admin
 * serve (`@iobroker/web-components`), so all React components of a page run on one React -- and this
 * module stays small.
 */

/** The shared sources live outside this package and are compiled into the bundle, not linked */
const packages = fileURLToPath(new URL('../packages', import.meta.url));

/**
 * The words the component shows (`word()` in `src/words.ts`). The whole dictionary is ~240 kB; these
 * are a few hundred bytes. The words of the manifest are `MANIFEST_WORDS` in `src/manifest.ts`.
 */
const WORDS = [
    'widget_label',
    'wc_choose_diagram',
    'wc_diagram_help',
    'history_no_data',
    'history_min',
    'history_avg',
    'history_max',
    'insp_history_no_adapter',
];

const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

function pickWords(keys: string[]): Record<string, Record<string, string>> {
    const picked: Record<string, Record<string, string>> = {};
    for (const lang of LANGUAGES) {
        const dictionary = JSON.parse(
            readFileSync(new URL(`../packages/translations/src/${lang}.json`, import.meta.url), 'utf8'),
        ) as Record<string, string>;
        picked[lang] = {};
        for (const key of keys) {
            if (dictionary[key]) {
                picked[lang][key] = dictionary[key];
            }
        }
    }
    return picked;
}

/** Writes `flow-diagram.json` next to the module, with the words in every language */
function manifestFile(): Plugin {
    return {
        name: 'flow-web-component-manifest',
        generateBundle() {
            const picked = pickWords(MANIFEST_WORDS);
            const manifest = buildManifest(key => {
                const all: Record<string, string> = {};
                for (const lang of LANGUAGES) {
                    if (picked[lang][key]) {
                        all[lang] = picked[lang][key];
                    }
                }
                if (!all.en) {
                    this.error(`The word "${key}" of the manifest has no English text`);
                }
                return all as WebComponentText;
            });
            const problem = checkManifest(manifest);
            if (problem) {
                this.error(`${MANIFEST_FILE}: ${problem}`);
            }
            this.emitFile({
                type: 'asset',
                fileName: MANIFEST_FILE,
                source: `${JSON.stringify(manifest, null, 4)}
`,
            });
        },
    };
}

const config = {
    plugins: [react(), manifestFile()],
    resolve: {
        alias: {
            '@flow/core': `${packages}/core/src/index.ts`,
        },
    },
    define: {
        __FLOW_WORDS__: JSON.stringify(pickWords(WORDS)),
        // The tag is the one of the manifest: a host checks that the module defines it
        __FLOW_TAG__: JSON.stringify(TAG),
        'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
        target: 'es2022',
        outDir: './build',
        emptyOutDir: true,
        lib: {
            entry: './src/index.tsx',
            formats: ['es'],
            fileName: (): string => 'flow-diagram.js',
        },
        rollupOptions: {
            external: [...REACT_SPECIFIERS],
            output: {
                paths: Object.fromEntries(REACT_SPECIFIERS.map(specifier => [specifier, REACT_19_URL])),
                // One file: a host imports exactly one URL
                codeSplitting: false,
                // Library mode keeps whitespace and comments for the bundler of a consumer; this
                // module is loaded as it is, by the browser of every page
                minify: true,
            },
        },
    },
};

export default config;
