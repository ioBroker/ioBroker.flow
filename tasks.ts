/*!
 * Build tasks for ioBroker.flow.
 *
 * Two bundles come out of one repository, each going to a place its host looks in:
 *
 * - `src-widgets/` -> `widgets/flow/`, declared in `io-package.json` as
 *   `common.visWidgets.flowWidgets.url`. This is what vis-2 loads.
 * - `src-dm-widgets/` -> `admin/dm-widgets/`, declared as `common.deviceWidgets.url`. This is what
 *   `pluginLoader.ts` of ioBroker.devices loads, and what `@iobroker/json-config` fetches the
 *   designer from.
 *
 * Executed with `tsx` (see the scripts in package.json), so this file is type checked by the root
 * tsconfig like the rest of the sources.
 *
 * There is no npm-install step per bundle: this is an npm workspace, so a single `npm install` at the
 * root installs both and hoists the shared copies of react, MUI and `@iobroker/gui-components` -- which
 * it *must*, because `packages/core` and `packages/editor` are compiled into both bundles and would
 * otherwise see a different React than the bundle around them.
 */
import { buildReact, copyFiles, deleteFoldersRecursive, patchHtmlFile } from '@iobroker/build-tools';
import { copyFileSync, existsSync, rmSync } from 'node:fs';

const VIS_SRC = 'src-widgets/';
const DM_SRC = 'src-dm-widgets/';
const ADMIN_SRC = 'src-admin/';

/** Where vis-2 expects the widget set; must match `common.visWidgets.*.url` */
const VIS_DEST = 'widgets/flow/';

/** Where ioBroker.devices expects the plugin; must match `common.deviceWidgets.url` */
const DM_DEST = 'admin/dm-widgets/';

/**
 * The admin tab. Admin loads `adapter/flow/tab.html` for an `adminTab` without a `link`, and
 * the chunks go into a folder of their own (`assetsDir` in `src-admin/vite.config.ts`) so that this
 * build and the device manager's one can each wipe their output without touching the other's.
 */
const TAB_HTML = 'admin/tab.html';
const TAB_ASSETS = 'admin/tab-assets/';

/**
 * Remove one bundle's build and its published copy.
 *
 * Every build has to start from an empty destination, the single-bundle ones included: Vite names its
 * chunks by content hash, so a rebuild writes *new* files next to the old ones instead of over them,
 * and the stale chunks would be published with the next release.
 */
function cleanBundle(src: string, dest: string): void {
    deleteFoldersRecursive(`${__dirname}/${src}build`);
    deleteFoldersRecursive(`${__dirname}/${dest}`);
}

function cleanAdmin(): void {
    cleanBundle(ADMIN_SRC, TAB_ASSETS);
    rmSync(`${__dirname}/${TAB_HTML}`, { force: true });
}

function clean(): void {
    cleanBundle(VIS_SRC, VIS_DEST);
    cleanBundle(DM_SRC, DM_DEST);
    cleanAdmin();
    deleteFoldersRecursive(`${__dirname}/widgets`);
}

/** Render the palette previews with the real renderer, so they cannot go stale */
async function previews(): Promise<void> {
    // Imported rather than spawned, so a failure is an exception here and not a silent non-zero exit
    await import('./tools/generatePreviews');
}

function compile(src: string): Promise<void> {
    return buildReact(`${__dirname}/${src}`, { rootDir: __dirname, vite: true });
}

/**
 * Copy a Vite build to where its host reads it.
 *
 * `mf-manifest.json` is deliberately **not** excluded from either: vis-2 reads it to decide whether a
 * widget set may be loaded at all (it checks that `react/jsx-runtime` is shared), and
 * `@iobroker/json-config` reads it to decide whether the designer may run (it checks which component
 * library the bundle was built against). Dropping it silently disables the thing it describes.
 */
function copyBuild(src: string, dest: string): void {
    copyFiles(
        [
            `${src}build/**/*`,
            // Entry page of the stand-alone dev server, not part of the published bundle
            `!${src}build/index.html`,
            // Statistics of the federation build; only `mf-manifest.json` is needed at runtime
            `!${src}build/mf-stats.json`,
            `!${src}build/*.ssr.js`,
        ],
        dest,
    );
}

function copyVis(): void {
    copyBuild(VIS_SRC, VIS_DEST);
    // The standalone dictionary next to the widgets. vis-2 loads the translations through the
    // federated `./translations` module, but the files are small and having them as plain JSON is what
    // lets `translate-adapter` and a human reviewer see what the set actually ships.
    copyFiles(['packages/translations/src/*.json'], `${VIS_DEST}i18n`);
}

function copyDm(): void {
    copyBuild(DM_SRC, DM_DEST);
    // The icon `common.deviceWidgets.components[].icon` points at, resolved by the device manager
    // relative to `admin/dm-widgets/`
    copyFiles(['admin/flow.svg'], DM_DEST);
}

/**
 * Put the tab where admin looks for it.
 *
 * `patchHtmlFile` swaps the dev-time socket loader for a static `<script>` tag; `'../..'` is the
 * path from `adapter/flow/tab.html` back to the web root, where admin serves `lib/js/socket.io.js`.
 */
async function copyAdmin(): Promise<void> {
    copyFiles([`${ADMIN_SRC}build/tab-assets/**/*`], TAB_ASSETS);
    await patchHtmlFile(`${__dirname}/${ADMIN_SRC}build/index.html`, '../..');
    copyFileSync(`${__dirname}/${ADMIN_SRC}build/index.html`, `${__dirname}/${TAB_HTML}`);
}

function fail(what: string, error: unknown): never {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
    console.error(`Cannot ${what}: ${message}`);
    process.exit(2);
}

async function main(): Promise<void> {
    const argv = process.argv;

    if (argv.includes('--clean')) {
        clean();
        return;
    }
    if (argv.includes('--previews')) {
        await previews();
        return;
    }
    if (argv.includes('--vis')) {
        cleanBundle(VIS_SRC, VIS_DEST);
        await compile(VIS_SRC);
        copyVis();
        return;
    }
    if (argv.includes('--dm')) {
        cleanBundle(DM_SRC, DM_DEST);
        await compile(DM_SRC);
        copyDm();
        return;
    }
    if (argv.includes('--admin')) {
        cleanAdmin();
        await compile(ADMIN_SRC);
        await copyAdmin();
        return;
    }

    clean();
    await previews();
    await compile(VIS_SRC);
    copyVis();
    await compile(DM_SRC);
    copyDm();
    await compile(ADMIN_SRC);
    await copyAdmin();

    // A missing bundle would only show up when somebody installs the adapter, so check it here
    for (const file of [`${VIS_DEST}customWidgets.js`, `${DM_DEST}customDevices.js`, TAB_HTML]) {
        if (!existsSync(`${__dirname}/${file}`)) {
            fail('build', new Error(`${file} was not produced`));
        }
    }
    // `copyFiles` creates the destination even for patterns that match nothing; drop an empty leftover
    // rather than publishing a directory that suggests there is something in it
    for (const folder of [`${VIS_DEST}_socket`, `${DM_DEST}_socket`]) {
        rmSync(`${__dirname}/${folder}`, { recursive: true, force: true });
    }

    console.log(`Built ${VIS_DEST}, ${DM_DEST} and ${TAB_HTML}`);
}

main().catch((error: unknown) => fail('build', error));
