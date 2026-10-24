'use strict';

// Assembles the web app into native/www, which Capacitor bundles into the
// native apps. Only the files the app needs are copied (no git, node_modules,
// CI scripts, etc.).

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const wwwDir = path.resolve(__dirname, '..', 'www');

// Files and directories relative to the repository root.
const INCLUDE = [
    'index.html',
    'share-histograms.html',
    'share-histograms.js',
    'course-widget-comments.html',
    'course-widget-histograms.html',
    'manifest.webmanifest',
    'cheesefork.css',
    'cheesefork-dark.css',
    'cheesefork-print.css',
    'loader.css',
    'dark-mode-toggle-stylesheets-loader.min.js',
    'course-manager.js',
    'cheesefork.js',
    'favicon.ico',
    'logo.png',
    'PRIVACY.md',
    'assets',
    'components',
    'icons',
    'mobile',
    'modules'
];

function copyRecursive(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, {recursive: true});
        for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dest, entry));
        }
    } else {
        fs.mkdirSync(path.dirname(dest), {recursive: true});
        fs.copyFileSync(src, dest);
    }
}

fs.rmSync(wwwDir, {recursive: true, force: true});
fs.mkdirSync(wwwDir, {recursive: true});

let count = 0;
for (const item of INCLUDE) {
    const src = path.join(repoRoot, item);
    if (!fs.existsSync(src)) {
        console.warn('skipping missing ' + item);
        continue;
    }
    copyRecursive(src, path.join(wwwDir, item));
    count++;
}

// The service worker is for the web version only; the native app has its own
// offline cache (mobile/platform.js).
console.log('www assembled: ' + count + ' entries copied to ' + wwwDir);
