'use strict';

// Service worker for the CheeseFork PWA: makes the app shell and the course
// data of the last semesters available offline.
//
// Strategies:
// - Navigations and the app's own JS/CSS: network first, cache fallback.
// - Third-party modules, fonts and images: cache first, refreshed in the
//   background (stale-while-revalidate).
// - Course data (sap/ug.cheesefork.cf): network first with a timeout, cache
//   fallback. Only the last few semesters are kept.
// - Firebase, analytics and everything else: untouched.

var VERSION = 'v4';
var SHELL_CACHE = 'cheesefork-shell-' + VERSION;
var RUNTIME_CACHE = 'cheesefork-runtime-' + VERSION;
var COURSES_CACHE = 'cheesefork-courses';
var COURSES_CACHE_MAX_ENTRIES = 4;

var INDEX_URL = new URL('index.html', self.location.href).href;

var SHELL = [
    'index.html',
    'manifest.webmanifest',
    'cheesefork.css',
    'cheesefork-dark.css',
    'cheesefork-print.css',
    'loader.css',
    'dark-mode-toggle-stylesheets-loader.min.js',
    'course-manager.js',
    'cheesefork.js',
    'mobile/platform.js',
    'mobile/cheesefork-mobile.js',
    'mobile/cheesefork-mobile.css',
    'mobile/cheesefork-app.js',
    'mobile/cheesefork-app.css',
    'mobile/cheesefork-tasks.js',
    'mobile/cheesefork-tasks.css',
    'components/course-select/course-select.css',
    'components/course-select/course-select.js',
    'components/course-button-list/course-button-list.css',
    'components/course-button-list/course-button-list.js',
    'components/course-exam-info/course-exam-info.css',
    'components/course-exam-info/course-exam-info.js',
    'components/course-calendar/course-calendar.css',
    'components/course-calendar/course-calendar.js',
    'components/course-feedback/course-feedback.css',
    'components/course-feedback/course-feedback.js',
    'components/histogram-browser/histogram-browser.css',
    'components/histogram-browser/histogram-browser.js',
    'components/course-grades/course-grades.css',
    'components/course-grades/course-grades.js',
    'modules/bootstrap-rtl/css/bootstrap.min.css',
    'modules/bootstrap4-dialog/css/bootstrap-dialog.min.css',
    'modules/OverlayScrollbars/css/OverlayScrollbars.min.css',
    'modules/fullcalendar/fullcalendar.min.css',
    'modules/selectize/css/selectize.bootstrap4.css',
    'modules/fontawesome/css/all.min.css',
    'modules/fontawesome/webfonts/fa-solid-900.woff2',
    'modules/fontawesome/webfonts/fa-regular-400.woff2',
    'modules/intro.js/introjs.min.css',
    'modules/intro.js/introjs-rtl.min.css',
    'modules/fullcalendar/lib/jquery.min.js',
    'modules/fullcalendar/lib/jquery-ui.min.js',
    'modules/popper/popper.js',
    'modules/bootstrap-rtl/js/bootstrap.min.js',
    'modules/bootstrap4-dialog/js/bootstrap-dialog.min.js',
    'modules/OverlayScrollbars/js/jquery.overlayScrollbars.min.js',
    'modules/fullcalendar/lib/moment.min.js',
    'modules/fullcalendar/fullcalendar.min.js',
    'modules/fullcalendar/locale/he.js',
    'modules/selectize/js/standalone/selectize.min.js',
    'modules/color-hash/color-hash.js',
    'modules/ics.js/ics.deps.min.js',
    'modules/jsdiff/diff.min.js',
    'modules/intro.js/intro.min.js',
    'modules/reparse.js',
    'modules/boolean-expression.js',
    'modules/dark-mode-toggle-0.14.6.min.mjs',
    'logo.png',
    'favicon.ico',
    'icons/favicon-32x32.png',
    'icons/favicon-16x16.png',
    'icons/android-chrome-192x192.png',
    'icons/android-chrome-512x512.png',
    'icons/maskable-512x512.png',
    'icons/apple-touch-icon.png',
    'assets/icon-sap.png',
    'assets/icon-students.png',
    'assets/icon-facebook.png',
    'assets/icon-scans.png',
    'assets/icon-webcourse.png',
    'assets/icon-whatsapp.png'
];

var COURSE_DATA_HOSTS = ['sap.cheesefork.cf', 'ug.cheesefork.cf'];
var STALE_WHILE_REVALIDATE_HOSTS = ['www.gstatic.com', 'michael-maltsev.github.io'];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(SHELL_CACHE).then(function (cache) {
            // Add the files one by one, a missing file shouldn't fail the install.
            return Promise.all(SHELL.map(function (url) {
                return cache.add(new Request(url, {cache: 'reload'})).catch(function () {});
            }));
        }).then(function () {
            return self.skipWaiting();
        })
    );
});

self.addEventListener('activate', function (event) {
    var keep = [SHELL_CACHE, RUNTIME_CACHE, COURSES_CACHE];
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.filter(function (key) {
                return key.indexOf('cheesefork-') === 0 && keep.indexOf(key) === -1;
            }).map(function (key) {
                return caches.delete(key);
            }));
        }).then(function () {
            return self.clients.claim();
        })
    );
});

self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') {
        return;
    }

    var url = new URL(request.url);

    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
        return;
    }

    if (url.origin === self.location.origin) {
        if (isStaticAsset(url.pathname)) {
            event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
        } else {
            event.respondWith(networkFirst(request, SHELL_CACHE, 8000));
        }
        return;
    }

    if (COURSE_DATA_HOSTS.indexOf(url.hostname) !== -1) {
        event.respondWith(networkFirst(request, COURSES_CACHE, 12000).then(function (response) {
            trimCache(COURSES_CACHE, COURSES_CACHE_MAX_ENTRIES);
            return response;
        }));
        return;
    }

    if (STALE_WHILE_REVALIDATE_HOSTS.indexOf(url.hostname) !== -1) {
        event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
        return;
    }
});

function isStaticAsset(pathname) {
    return /\/modules\//.test(pathname) ||
        /\.(png|ico|svg|jpg|jpeg|gif|webp|woff2?|ttf|eot)$/i.test(pathname);
}

function isCacheable(response) {
    return response && (response.ok || response.type === 'opaque');
}

function fetchWithTimeout(request, timeout) {
    return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
            reject(new Error('timeout'));
        }, timeout);
        fetch(request).then(function (response) {
            clearTimeout(timer);
            resolve(response);
        }, function (error) {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function handleNavigation(request) {
    return fetchWithTimeout(request, 8000).then(function (response) {
        if (response.ok) {
            var copy = response.clone();
            caches.open(SHELL_CACHE).then(function (cache) {
                cache.put(INDEX_URL, copy);
            });
        }
        return response;
    }).catch(function () {
        return caches.match(INDEX_URL).then(function (cached) {
            return cached || caches.match(request);
        }).then(function (cached) {
            return cached || Response.error();
        });
    });
}

function networkFirst(request, cacheName, timeout) {
    return fetchWithTimeout(request, timeout).then(function (response) {
        if (isCacheable(response)) {
            var copy = response.clone();
            caches.open(cacheName).then(function (cache) {
                cache.put(request, copy);
            });
        }
        return response;
    }).catch(function () {
        return caches.match(request).then(function (cached) {
            return cached || Response.error();
        });
    });
}

function staleWhileRevalidate(request, cacheName) {
    return caches.open(cacheName).then(function (cache) {
        return cache.match(request).then(function (cached) {
            var network = fetch(request).then(function (response) {
                if (isCacheable(response)) {
                    cache.put(request, response.clone());
                }
                return response;
            }).catch(function () {
                return cached || Response.error();
            });
            return cached || network;
        });
    });
}

function trimCache(cacheName, maxEntries) {
    caches.open(cacheName).then(function (cache) {
        cache.keys().then(function (keys) {
            if (keys.length <= maxEntries) {
                return;
            }
            // Keys are in insertion order, remove the oldest ones.
            keys.slice(0, keys.length - maxEntries).forEach(function (key) {
                cache.delete(key);
            });
        });
    });
}
