import compat from "eslint-plugin-compat";
import globals from "globals";

export default [
    {
        ignores: [
            "modules/",
            "node_modules/",
            "dark-mode-toggle-stylesheets-loader.min.js",
            "eslint.config.mjs",
            "share-histograms.js",
            "native/android/",
            "native/ios/",
            "native/www/",
            "native/node_modules/",
        ]
    },
    {
        plugins: {
            compat
        },
        languageOptions: {
            ecmaVersion: 5,
            sourceType: "script",
            globals: {
                ...globals.browser,
                ...globals.jquery
            }
        },
        rules: {
            "compat/compat": "error",
            "strict": ["error", "global"],
            "indent": ["error", 4],
            "no-unused-vars": ["error", { "args": "none", "caughtErrors": "none" }],
            "no-undef": "error",
            "semi": "error"
        }
    },
    {
        // The mobile layer and the service worker target modern browsers only.
        files: ["mobile/**/*.js", "sw.js"],
        languageOptions: {
            ecmaVersion: 2017,
            globals: {
                ...globals.browser,
                ...globals.serviceworker,
                ...globals.jquery
            }
        },
        rules: {
            "compat/compat": "off"
        }
    },
    {
        files: ["native/scripts/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node
            }
        },
        rules: {
            "compat/compat": "off"
        }
    }
];
