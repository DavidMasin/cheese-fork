'use strict';

// Platform detection for the mobile layer. Loaded early (before the course
// data), so that index.html and cheesefork.js can adapt to the environment:
//
// - "native": running inside the Capacitor app (Android/iOS). The course data
//   is loaded here asynchronously with an on-device cache, so the app works
//   offline too.
// - "standalone": the PWA installed to the home screen.
// - "web": a regular browser tab.

window.cheeseForkPlatform = (function () {
    var capacitor = window.Capacitor;
    var isNative = !!(capacitor && typeof capacitor.isNativePlatform === 'function' && capacitor.isNativePlatform());

    var isStandalone = false;
    try {
        isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
            window.navigator.standalone === true;
    } catch (e) {
        // Ignore.
    }

    var platform = {
        isNative: isNative,
        isStandalone: isStandalone,
        os: isNative ? capacitor.getPlatform() : 'web',
        // Keep local copies of remote data (Firestore, course data) for offline use.
        wantsOfflineData: isNative || isStandalone,
        // True when the course data was served from the on-device cache.
        coursesFromCache: false,
        coursesCacheDate: null,
        // Set by cheesefork-mobile.js in the native app (share sheet for files).
        saveTextFile: null,
        plugin: function (name) {
            if (!isNative || !capacitor.Plugins) {
                return null;
            }
            return capacitor.Plugins[name] || null;
        }
    };

    // Max age of the cached course data before trying the network first.
    var COURSES_CACHE_FRESH_MS = 6 * 60 * 60 * 1000;

    function executeScript(text) {
        var script = document.createElement('script');
        script.text = text;
        document.head.appendChild(script);
        document.head.removeChild(script);
    }

    function coursesReady() {
        document.dispatchEvent(new CustomEvent('cheesefork:courses-ready'));
    }

    function coursesFailed(coursesUrl, semester) {
        var retry = window.confirm('טעינת נתוני הקורסים נכשלה. בדקו את החיבור לאינטרנט ונסו שוב.\n\nלנסות שוב?');
        if (retry) {
            platform.loadCourses(coursesUrl, semester);
        }
    }

    // Loads the courses script of the semester: from the network when the
    // cached copy is old (or missing), otherwise from the cache with a
    // background refresh for the next launch.
    platform.loadCourses = function (coursesUrl, semester) {
        var filesystem = platform.plugin('Filesystem');
        var http = platform.plugin('CapacitorHttp');
        var cachePath = 'courses/' + semester + '.js';
        var cacheOptions = {path: cachePath, directory: 'DATA', encoding: 'utf8'};

        function fetchFromNetwork() {
            if (!http) {
                return Promise.reject(new Error('CapacitorHttp is not available'));
            }
            return http.get({
                url: coursesUrl,
                responseType: 'text',
                connectTimeout: 20000,
                readTimeout: 30000
            }).then(function (response) {
                if (response.status !== 200 || typeof response.data !== 'string' || response.data.length < 1000) {
                    throw new Error('Bad response: ' + response.status);
                }
                return response.data;
            });
        }

        function readCache() {
            if (!filesystem) {
                return Promise.reject(new Error('Filesystem is not available'));
            }
            return filesystem.stat({path: cachePath, directory: 'DATA'}).then(function (stat) {
                return filesystem.readFile(cacheOptions).then(function (result) {
                    return {text: result.data, mtime: stat.mtime || 0};
                });
            });
        }

        function writeCache(text) {
            if (!filesystem) {
                return Promise.resolve();
            }
            return filesystem.writeFile({
                path: cachePath,
                directory: 'DATA',
                encoding: 'utf8',
                data: text,
                recursive: true
            }).catch(function () {
                // Not critical.
            });
        }

        function useNetworkThenCache() {
            return fetchFromNetwork().then(function (text) {
                executeScript(text);
                coursesReady();
                writeCache(text);
            }, function () {
                return readCache().then(function (cached) {
                    platform.coursesFromCache = true;
                    platform.coursesCacheDate = new Date(cached.mtime);
                    executeScript(cached.text);
                    coursesReady();
                });
            });
        }

        readCache().then(function (cached) {
            var age = Date.now() - cached.mtime;
            if (age >= 0 && age < COURSES_CACHE_FRESH_MS) {
                // Fresh enough: start fast from the cache, refresh in the background.
                platform.coursesFromCache = true;
                platform.coursesCacheDate = new Date(cached.mtime);
                executeScript(cached.text);
                coursesReady();
                fetchFromNetwork().then(writeCache, function () {});
                return null;
            }
            return useNetworkThenCache();
        }, function () {
            return useNetworkThenCache();
        }).then(null, function () {
            coursesFailed(coursesUrl, semester);
        });
    };

    return platform;
})();
