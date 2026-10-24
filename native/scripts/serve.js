'use strict';

// A tiny static server for trying the web app locally (including the PWA
// features, which need localhost or https):
//
//   node native/scripts/serve.js [port]
//
// Then open http://localhost:8080/ in the browser.

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const port = parseInt(process.argv[2], 10) || 8080;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.md': 'text/markdown; charset=utf-8',
    '.xml': 'application/xml'
};

http.createServer((request, response) => {
    let urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (urlPath.endsWith('/')) {
        urlPath += 'index.html';
    }

    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        response.writeHead(404);
        response.end('Not found');
        return;
    }

    response.writeHead(200, {
        'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(response);
}).listen(port, () => {
    console.log('CheeseFork is served at http://localhost:' + port + '/');
});
