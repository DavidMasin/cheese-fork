'use strict';

// iPhone app: lets Firebase sign-in work like on Android.
//
// CheeseFork's Firebase API key only accepts sign-in requests whose referrer
// is https://cheesefork.cf/. Android's web view can serve the bundled app on
// that origin, but iOS doesn't allow apps to serve pages on https:// (the
// app runs on capacitor://cheesefork.cf), so Google rejects the sign-in and
// token-refresh requests. This sends just those requests (Firebase Auth's
// fetch calls to identitytoolkit / securetoken) through Capacitor's native
// HTTP with the cheesefork.cf referrer. Firestore accepts the app's origin
// as is, so sync itself needs nothing special.
//
// Must load before the Firebase SDK. Does nothing outside the iOS app.

(function () {
    var AUTH_HOSTS = /^https:\/\/(identitytoolkit|securetoken)\.googleapis\.com\//i;
    var REFERER = 'https://cheesefork.cf/';

    function headersToObject(headers) {
        var result = {};
        if (!headers) {
            return result;
        }
        if (Array.isArray(headers)) {
            headers.forEach(function (pair) {
                result[pair[0]] = pair[1];
            });
        } else if (typeof headers.forEach === 'function') {
            headers.forEach(function (value, key) {
                result[key] = value;
            });
        } else {
            Object.keys(headers).forEach(function (key) {
                result[key] = headers[key];
            });
        }
        return result;
    }

    function bodyToText(body) {
        if (body === undefined || body === null) {
            return Promise.resolve(undefined);
        }
        if (typeof body === 'string') {
            return Promise.resolve(body);
        }
        if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
            return Promise.resolve(body.toString());
        }
        if (typeof Blob !== 'undefined' && body instanceof Blob) {
            return body.text();
        }
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
            return Promise.resolve(new TextDecoder().decode(body));
        }
        return Promise.resolve(String(body));
    }

    function hasHeader(headers, name) {
        return Object.keys(headers).some(function (key) {
            return key.toLowerCase() === name;
        });
    }

    function install(win, http) {
        var originalFetch = win.fetch.bind(win);

        function nativeFetch(url, input, init) {
            var isRequest = input && typeof input === 'object' && typeof input.url === 'string';
            var method = String(init.method || (isRequest && input.method) || 'GET').toUpperCase();
            var headers = headersToObject(isRequest ? input.headers : null);
            var extra = headersToObject(init.headers);
            Object.keys(extra).forEach(function (key) {
                headers[key] = extra[key];
            });

            var bodyPromise;
            if (init.body !== undefined) {
                bodyPromise = bodyToText(init.body);
            } else if (isRequest && method !== 'GET' && method !== 'HEAD') {
                bodyPromise = input.text();
            } else {
                bodyPromise = Promise.resolve(undefined);
            }

            return bodyPromise.then(function (data) {
                if (data !== undefined && !hasHeader(headers, 'content-type')) {
                    headers['Content-Type'] = 'text/plain;charset=UTF-8';
                }
                headers.Referer = REFERER;
                return http.request({
                    url: url,
                    method: method,
                    headers: headers,
                    data: data,
                    responseType: 'text',
                    connectTimeout: 30000,
                    readTimeout: 30000
                }).catch(function () {
                    throw new TypeError('Network request failed');
                });
            }).then(function (response) {
                var text = response.data;
                if (text !== undefined && text !== null && typeof text !== 'string') {
                    text = JSON.stringify(text);
                }
                var status = response.status || 0;
                if (status < 200 || status > 599) {
                    throw new TypeError('Network request failed');
                }
                var responseHeaders;
                try {
                    responseHeaders = new Headers(response.headers || {});
                } catch (e) {
                    responseHeaders = new Headers();
                }
                var nullBody = status === 204 || status === 205 || status === 304;
                return new Response(nullBody ? null : (text || ''), {status: status, headers: responseHeaders});
            });
        }

        win.fetch = function (input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || String(input);
            if (!AUTH_HOSTS.test(url)) {
                return originalFetch(input, init);
            }
            return nativeFetch(url, input, init || {});
        };
    }

    window.cheeseForkAuthBridge = {
        install: install,
        AUTH_HOSTS: AUTH_HOSTS
    };

    var platform = window.cheeseForkPlatform;
    if (!platform || !platform.isNative || platform.os !== 'ios' || typeof window.fetch !== 'function') {
        return;
    }
    var http = platform.plugin('CapacitorHttp');
    if (http) {
        install(window, http);
    }
})();
