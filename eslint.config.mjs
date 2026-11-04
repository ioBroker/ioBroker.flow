import config from '@iobroker/eslint-config';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                // No allowDefaultProject: the root tsconfig.json already includes "*.mjs" and tasks.ts,
                // and listing the same file in both makes the project service refuse to parse it.
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // The shared sources, the host bundles and the dev preview are React
        files: [
            'packages/*/src/**/*.{ts,tsx}',
            'src-widgets/src/**/*.{ts,tsx}',
            'src-dm-widgets/src/**/*.{ts,tsx}',
            'src-webcomponents/src/**/*.{ts,tsx}',
            'src-admin/src/**/*.{ts,tsx}',
            'src-preview/src/**/*.{ts,tsx}',
        ],
        ...react.configs.flat.recommended,
        plugins: {
            react,
            'react-hooks': reactHooks,
        },
        languageOptions: {
            ...react.configs.flat.recommended.languageOptions,
            globals: {
                ...globals.browser,
            },
            parserOptions: {
                ecmaFeatures: { jsx: true },
            },
        },
        settings: { react: { version: 'detect' } },
        rules: {
            ...react.configs.flat.recommended.rules,
            ...reactHooks.configs.recommended.rules,
            // The JSX runtime is automatic
            'react/react-in-jsx-scope': 'off',
            // The props are typed with TypeScript
            'react/prop-types': 'off',
        },
    },
    {
        rules: {
            // Same call as in the other ioBroker widget sets: the rule fires on every inline arrow
            // function in JSX and on every class member, which buries the comments that do carry
            // information. What is worth explaining is explained.
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
        },
    },
    {
        ignores: [
            'admin/**/*',
            'widgets/**/*',
            'node_modules/**/*',
            '**/node_modules/**/*',
            '**/build/**/*',
            'src-widgets/public/**/*',
            'src-dm-widgets/public/**/*',
            'tmp/**/*',
            '.**/*',
        ],
    },
];
