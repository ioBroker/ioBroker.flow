/**
 * The manifest of `<iob-flow-diagram>`.
 *
 * The build writes it as `flow-diagram.json` next to the module (`vite.config.ts`), and
 * `common.webComponents` names that file: a host reads it for its palette and its settings without
 * loading the module. Run by the build only, with the words of the dictionary; the module gets the
 * tag as `__FLOW_TAG__`.
 */
import type { WebComponentManifest, WebComponentText } from '@iobroker/web-components';

export const TAG = 'iob-flow-diagram';

/** The file the build writes, next to `flow-diagram.js` */
export const MANIFEST_FILE = 'flow-diagram.json';

/** The words of the manifest: in every language, hosts translate them themselves */
export const MANIFEST_WORDS = [
    'widget_label',
    'wc_help',
    'insp_diagram',
    'wc_diagram_help',
    'name',
    'wc_hide_labels',
    'no_animation',
    'wc_full_view',
];

/**
 * The manifest with the words of the dictionary
 *
 * @param words a word of `MANIFEST_WORDS` in all languages
 */
export function buildManifest(words: (key: string) => WebComponentText): WebComponentManifest {
    return {
        $schema: 'https://raw.githubusercontent.com/ioBroker/web-components/main/schemas/manifest.json',
        manifestVersion: 1,
        tag: TAG,
        name: words('widget_label'),
        // not the help of the vis-2 widget: this one has no designer, it shows a stored diagram
        description: words('wc_help'),
        // relative to this file: /adapter/flow/flow.svg
        icon: '../flow.svg',
        module: 'flow-diagram.js',
        size: { width: 480, height: 340 },
        settings: {
            type: 'panel',
            items: {
                diagram: {
                    type: 'objectId',
                    label: words('insp_diagram'),
                    help: words('wc_diagram_help'),
                    types: 'config',
                    root: 'flow.0.diagrams',
                },
                title: { type: 'text', label: words('name') },
                hideLabels: { type: 'checkbox', label: words('wc_hide_labels') },
                noAnimation: { type: 'checkbox', label: words('no_animation') },
                fullView: { type: 'checkbox', label: words('wc_full_view') },
            },
        },
    };
}
