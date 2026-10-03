import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The ioBroker admin the preview talks to -- socket, socket.io client, icons and files all come from
 * here. Change it to work against another machine, e.g. `'http://localhost:8081'`; the environment
 * variable `IOBROKER_ADMIN` overrides it for a single run without touching the file.
 */
const ADMIN_URL = process.env.IOBROKER_ADMIN || 'http://100.100.159.33:8081';

/**
 * The development preview: the admin-side GUI with hot reload, against a running ioBroker.
 *
 * Never built and never shipped -- it only exists as a dev server. It compiles the same sources as
 * the real bundles (the shared packages, and the admin tab's page straight out of `src-admin/src`),
 * so an edit in any of them shows up here the moment it is saved, without `npm run build` and
 * `iobroker upload`.
 *
 * It does not use port 3000, the port `@iobroker/socket-client` treats as "dev server, admin is on
 * 8081": that port is usually taken by the vis-2 dev server already. The preview names admin's
 * address itself instead, so any port works; `PORT` overrides the default.
 */
const packages = fileURLToPath(new URL('../packages', import.meta.url));
const admin = new URL(ADMIN_URL);
const adminPort = admin.port || (admin.protocol === 'https:' ? '443' : '80');

const config = {
    plugins: [
        react(),
        {
            // The socket.io client has to be loaded before the app starts, so `index.html` needs the
            // address as well -- as text, since no module code runs that early
            name: 'flow-admin-address',
            transformIndexHtml: (html: string): string =>
                html.replace(/%ADMIN_ORIGIN%/g, `${admin.protocol}//${admin.hostname}:${adminPort}`),
        },
    ],
    define: {
        __ADMIN_PROTOCOL__: JSON.stringify(admin.protocol),
        __ADMIN_HOST__: JSON.stringify(admin.hostname),
        __ADMIN_PORT__: JSON.stringify(adminPort),
    },
    resolve: {
        alias: {
            '@flow/core': `${packages}/core/src/index.ts`,
            '@flow/editor': `${packages}/editor/src/index.ts`,
            '@flow/i18n': `${packages}/translations/src/index.ts`,
        },
        dedupe: ['react', 'react-dom', '@emotion/react', '@mui/material', '@mui/system', '@mui/icons-material'],
    },
    server: {
        port: Number(process.env.PORT) || 3100,
        open: true,
        fs: { allow: ['..'] },
        // Icons, images and files the pages reference by admin-relative URLs
        proxy: {
            '/adapter': ADMIN_URL,
            '/lib': ADMIN_URL,
            '/files': ADMIN_URL,
        },
    },
    base: './',
};

export default config;
