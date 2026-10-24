'use strict';

/* global moment, BootstrapDialog, gtag */

// Moodle integration through Moodle's own mobile web service: the app gets a
// token the same way the official Moodle app does (browser login, token
// handed back through the cheesefork:// URL scheme), then reads the enrolled
// courses, their files and assignments. Provides:
// - a "new on Moodle" feed (files/activities added since the last check)
// - material matched to a lesson (slides for the next lecture, the tutorial
//   sheet for the next tutorial) with download links
// - assignments with due dates and links for the tasks tab
// - a materials list for the AI helper
// Everything is stored on the device only.

(function () {
    var STORAGE_KEY = 'cheeseForkMoodleWs';
    var DEFAULT_SITE = 'https://moodle.technion.ac.il';
    var SYNC_INTERVAL_MS = 30 * 60 * 1000;
    var RECENT_DAYS = 21;
    var MAX_COURSES = 15;

    var platform = window.cheeseForkPlatform || {isNative: false, plugin: function () { return null; }};
    var api = null;
    var mobile = null;

    var state = {
        syncing: false,
        containers: []
    };

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    function loadData() {
        var data;
        try {
            data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        } catch (e) {
            data = {};
        }
        data.siteUrl = data.siteUrl || DEFAULT_SITE;
        data.courses = data.courses || [];
        data.items = data.items || [];
        data.snapshot = data.snapshot || {};
        data.newKeys = data.newKeys || [];
        return data;
    }

    function saveData(data) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // Ignore (quota).
        }
        $(document).trigger('cheesefork:moodle-changed');
        renderAll();
    }

    function isConnected() {
        return !!loadData().token;
    }

    // ---------------------------------------------------------------------
    // Moodle REST
    // ---------------------------------------------------------------------

    function flattenParams(params, prefix, into) {
        Object.keys(params).forEach(function (key) {
            var value = params[key];
            var name = prefix ? prefix + '[' + key + ']' : key;
            if (value !== null && typeof value === 'object') {
                flattenParams(value, name, into);
            } else {
                into[name] = String(value);
            }
        });
        return into;
    }

    function restCall(data, wsfunction, params) {
        var query = flattenParams(params || {}, '', {
            wstoken: data.token,
            wsfunction: wsfunction,
            moodlewsrestformat: 'json'
        });
        var url = data.siteUrl.replace(/\/$/, '') + '/webservice/rest/server.php';

        var http = platform.plugin('CapacitorHttp');
        var request;
        if (http) {
            request = http.get({url: url, params: query, connectTimeout: 20000, readTimeout: 30000}).then(function (response) {
                if (response.status !== 200) {
                    throw new Error('HTTP ' + response.status);
                }
                return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
            });
        } else {
            var search = Object.keys(query).map(function (key) {
                return encodeURIComponent(key) + '=' + encodeURIComponent(query[key]);
            }).join('&');
            request = fetch(url + '?' + search).then(function (response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status);
                }
                return response.json();
            });
        }

        return request.then(function (result) {
            if (result && result.exception) {
                var error = new Error(result.message || result.errorcode || 'Moodle error');
                error.errorcode = result.errorcode;
                throw error;
            }
            return result;
        });
    }

    // ---------------------------------------------------------------------
    // Connecting (browser SSO handoff, or a pasted token)
    // ---------------------------------------------------------------------

    function randomHex(length) {
        var text = '';
        for (var i = 0; i < length; i++) {
            text += Math.floor(Math.random() * 16).toString(16);
        }
        return text;
    }

    // Asks Moodle (public endpoint, same as the official app) for its real
    // address and login URL, e.g. moodle.technion.ac.il -> moodle26.technion.ac.il.
    function discoverSite(siteUrl) {
        var base = siteUrl.replace(/\/$/, '');
        var url = base + '/lib/ajax/service-nologin.php?args=' +
            encodeURIComponent('[{"index":0,"methodname":"tool_mobile_get_public_config","args":{}}]');
        var http = platform.plugin('CapacitorHttp');
        var request = http
            ? http.get({url: url, connectTimeout: 15000, readTimeout: 20000}).then(function (response) {
                return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
            })
            : fetch(url).then(function (response) {
                return response.json();
            });
        return request.then(function (result) {
            var config = result && result[0] && !result[0].error ? result[0].data : null;
            if (!config || !config.wwwroot) {
                throw new Error('no-config');
            }
            return {
                wwwroot: String(config.wwwroot).replace(/\/$/, ''),
                launchurl: config.launchurl || (String(config.wwwroot).replace(/\/$/, '') + '/admin/tool/mobile/launch.php'),
                mobileEnabled: config.enablemobilewebservice !== 0 && config.enablemobilewebservice !== false,
                forcedScheme: config.forcedurlscheme || null
            };
        });
    }

    function connectViaBrowser() {
        trackEvent('moodle-sso-start');
        var data = loadData();
        var waiting = showWaitingDialog();

        discoverSite(data.siteUrl).catch(function () {
            return {wwwroot: data.siteUrl.replace(/\/$/, ''), launchurl: data.siteUrl.replace(/\/$/, '') + '/admin/tool/mobile/launch.php', mobileEnabled: true, forcedScheme: null};
        }).then(function (config) {
            if (!config.mobileEnabled) {
                waiting.close();
                toast('שירות האפליקציות של Moodle כבוי באתר זה');
                return;
            }
            var latest = loadData();
            latest.passport = randomHex(32);
            latest.pendingSite = config.wwwroot;
            latest.siteUrl = config.wwwroot;
            saveData(latest);

            var scheme = config.forcedScheme || 'cheesefork';
            var url = config.launchurl + '?service=moodle_mobile_app&passport=' + latest.passport + '&urlscheme=' + encodeURIComponent(scheme);
            waiting.setUrl(url, scheme !== 'cheesefork');
            if (mobile) {
                mobile.openExternal(url);
            } else {
                window.open(url, '_blank', 'noopener');
            }
        });
    }

    function showWaitingDialog() {
        var link = $('<a class="btn btn-outline-primary btn-sm d-none" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i> פתיחת ההתחברות ידנית</a>');
        var note = $('<div class="cf-mobile-small text-muted mt-2"></div>');
        var tokenInput = $('<input type="password" class="form-control form-control-sm mt-2" dir="ltr" placeholder="או הדביקו כאן מפתח מ-Moodle">');
        var dialog = BootstrapDialog.show({
            title: 'התחברות ל-Moodle',
            message: $('<div></div>').append(
                '<p>הדפדפן נפתח להזדהות טכניונית. אחרי ההתחברות Moodle יחזיר אתכם לאפליקציה (אם Android שואל, בחרו "CheeseFork").</p>',
                link, note, tokenInput),
            buttons: [{
                label: 'חיבור עם מפתח',
                action: function (d) {
                    var token = tokenInput.val().trim();
                    if (!token) {
                        return;
                    }
                    d.close();
                    connectWithToken(token, null, loadData().pendingSite || loadData().siteUrl);
                }
            }, {
                label: 'סגור',
                cssClass: 'btn-primary',
                action: function (d) {
                    d.close();
                }
            }]
        });
        var handler = function () {
            dialog.close();
        };
        $(document).one('cheesefork:moodle-synced', handler);
        return {
            close: function () {
                $(document).off('cheesefork:moodle-synced', handler);
                dialog.close();
            },
            setUrl: function (url, forcedScheme) {
                link.prop('href', url).removeClass('d-none');
                if (forcedScheme) {
                    note.text('האתר מחייב את אפליקציית Moodle הרשמית לקבלת המפתח. אפשר במקום זאת להדביק מפתח ידנית.');
                } else {
                    note.text('אם הדפדפן לא נפתח, לחצו על הכפתור למעלה.');
                }
            }
        };
    }

    // Handles cheesefork://token=<base64(siteid:::token:::privatetoken)>.
    function handleAppUrl(url) {
        var match = /^cheesefork:\/\/token=([A-Za-z0-9+/=%_-]+)/i.exec(url || '');
        if (!match) {
            return false;
        }
        trackEvent('moodle-sso-callback');
        var decoded;
        try {
            decoded = atob(decodeURIComponent(match[1]).replace(/-/g, '+').replace(/_/g, '/'));
        } catch (e) {
            toast('קוד ההתחברות מ-Moodle לא תקין');
            return true;
        }
        var parts = decoded.split(':::');
        if (parts.length < 2) {
            toast('קוד ההתחברות מ-Moodle לא תקין');
            return true;
        }

        var data = loadData();
        if (!data.passport || !data.pendingSite) {
            // No login was started from the app; ignore stray/forged URLs.
            toast('לא התחלתם התחברות ל-Moodle מהאפליקציה');
            return true;
        }
        var expected = md5(data.pendingSite.replace(/\/$/, '') + data.passport);
        if (parts[0] !== expected && parts[0] !== md5(data.pendingSite + data.passport)) {
            toast('ההתחברות ל-Moodle לא אומתה, נסו שוב');
            return true;
        }

        var browser = platform.plugin('Browser');
        if (browser) {
            browser.close().catch(function () {});
        }
        connectWithToken(parts[1], parts[2] || null, data.pendingSite);
        return true;
    }

    function connectWithToken(token, privateToken, siteUrl) {
        var data = loadData();
        data.siteUrl = (siteUrl || data.siteUrl).replace(/\/$/, '');
        data.token = token;
        data.privateToken = privateToken || null;
        data.passport = null;
        data.pendingSite = null;
        data.lastError = null;
        saveData(data);
        toast('מתחבר ל-Moodle...');
        return sync(true);
    }

    // Background checks (Android): a periodic worker compares the courses
    // with the snapshot the app last saw and notifies about new items.
    function configureBackground(data) {
        var background = platform.plugin('MoodleBackground');
        if (!background) {
            return;
        }
        if (!data.token || data.background === false) {
            background.disable().catch(function () {});
            return;
        }
        var notifications = platform.plugin('LocalNotifications');
        var permission = notifications ? notifications.requestPermissions().catch(function () {
            return null;
        }) : Promise.resolve(null);
        permission.then(function () {
            return background.configure({
                siteUrl: data.siteUrl,
                token: data.token,
                courses: data.courses.map(function (course) {
                    return {id: course.id, name: course.fullname};
                }),
                snapshot: data.snapshot,
                intervalMinutes: 30
            });
        }).catch(function () {});
    }

    function setBackgroundEnabled(enabled) {
        var data = loadData();
        data.background = enabled;
        saveData(data);
        configureBackground(data);
    }

    function disconnect() {
        var data = loadData();
        var background = platform.plugin('MoodleBackground');
        if (background) {
            background.disable().catch(function () {});
        }
        localStorage.removeItem(STORAGE_KEY);
        if (window.cheeseForkTasks) {
            window.cheeseForkTasks.removeTasksBySource('moodlews');
        }
        saveData({siteUrl: data.siteUrl});
    }

    // ---------------------------------------------------------------------
    // Sync
    // ---------------------------------------------------------------------

    function courseNumberIn(text) {
        if (!api) {
            return null;
        }
        var numbers = String(text || '').match(/\d{6,10}/g) || [];
        for (var i = 0; i < numbers.length; i++) {
            var candidate = numbers[i].length > 8 ? numbers[i].slice(0, 8) : numbers[i];
            var course = api.courseManager.stringToCourseNumber(candidate);
            if (course) {
                course = api.courseManager.toSemesterFormatCourseNumber(course);
                if (api.courseManager.doesExist(course)) {
                    return course;
                }
            }
        }
        return null;
    }

    function stripHtml(html) {
        return $('<div>').html(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')).text().replace(/\n{3,}/g, '\n\n').trim();
    }

    function kindOf(modname, text) {
        if (modname === 'assign') {
            return 'homework';
        }
        if (modname === 'quiz') {
            return 'quiz';
        }
        if (modname === 'forum') {
            return 'forum';
        }
        if (/תרגיל[י]?\s*בית|ת"ב|\bhw\s*\d|homework|assignment|מטלה|להגשה|הגשה/i.test(text)) {
            return 'homework';
        }
        if (/פתרון|פתרונות|solution/i.test(text)) {
            return 'solution';
        }
        if (/תרגול|תירגול|תרגולים|tutorial|recitation|\btut\b|דף\s*תרגול|תרגיל\s*\d/i.test(text)) {
            return 'tutorial';
        }
        if (/הרצא|lecture|מצגת|slides|שיעור|שקפים|שקופיות/i.test(text)) {
            return 'lecture';
        }
        if (/מעבדה|\blab\b/i.test(text)) {
            return 'lab';
        }
        return 'other';
    }

    var KIND_LABELS = {
        lecture: 'הרצאה',
        tutorial: 'תרגול',
        homework: 'תרגיל בית',
        solution: 'פתרון',
        quiz: 'בוחן',
        forum: 'פורום',
        lab: 'מעבדה',
        other: 'קובץ'
    };

    var KIND_ICONS = {
        lecture: 'fa-chalkboard-teacher',
        tutorial: 'fa-pencil-alt',
        homework: 'fa-file-signature',
        solution: 'fa-check-double',
        quiz: 'fa-question-circle',
        forum: 'fa-comments',
        lab: 'fa-flask',
        other: 'fa-file'
    };

    function fileLink(data, fileurl) {
        if (!fileurl) {
            return null;
        }
        return fileurl + (fileurl.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(data.token);
    }

    function sync(interactive) {
        var data = loadData();
        if (!data.token || state.syncing) {
            return Promise.resolve(null);
        }
        state.syncing = true;
        renderAll();

        var now = Date.now();
        var courses = [];

        return restCall(data, 'core_webservice_get_site_info', {}).then(function (info) {
            data.userId = info.userid;
            data.userName = info.fullname;
            if (info.siteurl) {
                data.siteUrl = info.siteurl.replace(/\/$/, '');
            }
            return restCall(data, 'core_enrol_get_users_courses', {userid: info.userid, returnusercount: 0});
        }).then(function (list) {
            var cutoff = now / 1000 - 45 * 24 * 3600;
            courses = (list || []).filter(function (course) {
                if (course.visible === 0) {
                    return false;
                }
                return !course.enddate || course.enddate > cutoff;
            }).sort(function (a, b) {
                return (b.lastaccess || 0) - (a.lastaccess || 0);
            }).slice(0, MAX_COURSES).map(function (course) {
                return {
                    id: course.id,
                    fullname: course.fullname,
                    shortname: course.shortname,
                    course: courseNumberIn(course.fullname) || courseNumberIn(course.shortname) || courseNumberIn(course.idnumber),
                    lastaccess: course.lastaccess || 0
                };
            });
            data.courses = courses;

            return Promise.all(courses.map(function (course) {
                return restCall(data, 'core_course_get_contents', {
                    courseid: course.id,
                    options: [{name: 'excludemodules', value: 0}]
                }).then(function (sections) {
                    return {course: course, sections: sections || []};
                }, function () {
                    return {course: course, sections: []};
                });
            }));
        }).then(function (results) {
            var items = [];
            results.forEach(function (result) {
                var course = result.course;
                result.sections.forEach(function (section) {
                    (section.modules || []).forEach(function (module) {
                        if (module.uservisible === false || module.visible === 0) {
                            return;
                        }
                        if (module.modname === 'label') {
                            return;
                        }
                        var base = {
                            cmid: module.id,
                            courseId: course.id,
                            course: course.course,
                            courseName: course.fullname,
                            section: section.name || '',
                            modname: module.modname,
                            name: module.name,
                            moduleUrl: module.url || (data.siteUrl + '/mod/' + module.modname + '/view.php?id=' + module.id)
                        };
                        var files = (module.contents || []).filter(function (content) {
                            return content.type === 'file' && content.fileurl;
                        });
                        var dueDate = null;
                        (module.dates || []).forEach(function (date) {
                            if (/due|close/i.test(date.dataid || '') && date.timestamp) {
                                dueDate = date.timestamp * 1000;
                            }
                        });
                        if (files.length > 0 && module.modname !== 'assign') {
                            files.forEach(function (file) {
                                items.push($.extend({}, base, {
                                    key: 'f' + module.id + ':' + file.filename,
                                    filename: file.filename,
                                    url: fileLink(data, file.fileurl),
                                    mimetype: file.mimetype || '',
                                    size: file.filesize || 0,
                                    timemodified: (file.timemodified || 0) * 1000,
                                    kind: kindOf(module.modname, module.name + ' ' + section.name + ' ' + file.filename)
                                }));
                            });
                        } else {
                            items.push($.extend({}, base, {
                                key: 'm' + module.id,
                                filename: null,
                                url: base.moduleUrl,
                                timemodified: ((module.timemodified || 0) * 1000) || dueDate || 0,
                                due: dueDate,
                                kind: kindOf(module.modname, module.name + ' ' + section.name)
                            }));
                        }
                    });
                });
            });

            // New since the last sync (first sync: the last 7 days).
            var firstSync = !data.lastSync;
            var newKeys = data.newKeys.slice();
            var known = {};
            newKeys.forEach(function (entry) {
                known[entry.key] = true;
            });
            items.forEach(function (item) {
                var previous = data.snapshot[item.key];
                var isNew = firstSync
                    ? item.timemodified > now - 7 * 24 * 3600 * 1000
                    : (previous === undefined || item.timemodified > previous);
                if (isNew && !known[item.key] && item.timemodified > now - 60 * 24 * 3600 * 1000) {
                    newKeys.push({key: item.key, foundAt: now});
                    known[item.key] = true;
                }
            });
            // Keep at most 60 unread entries.
            data.newKeys = newKeys.slice(-60);

            var snapshot = {};
            items.forEach(function (item) {
                snapshot[item.key] = item.timemodified;
            });
            data.snapshot = snapshot;
            data.items = items.sort(function (a, b) {
                return b.timemodified - a.timemodified;
            }).slice(0, 600);

            var courseIds = courses.map(function (course) {
                return course.id;
            });
            if (courseIds.length === 0) {
                return null;
            }
            return restCall(data, 'mod_assign_get_assignments', {courseids: courseIds}).then(function (result) {
                var assignments = [];
                ((result && result.courses) || []).forEach(function (course) {
                    var mapped = courses.filter(function (item) {
                        return item.id === course.id;
                    })[0];
                    (course.assignments || []).forEach(function (assignment) {
                        if (!assignment.duedate && assignment.timemodified < now / 1000 - 30 * 24 * 3600) {
                            return;
                        }
                        assignments.push({
                            id: 'moodlews:' + assignment.id,
                            title: assignment.name,
                            course: mapped ? mapped.course : null,
                            courseName: course.fullname || (mapped ? mapped.fullname : ''),
                            due: assignment.duedate ? moment(assignment.duedate * 1000).format('YYYY-MM-DDTHH:mm') : null,
                            url: data.siteUrl + '/mod/assign/view.php?id=' + assignment.cmid,
                            description: stripHtml(assignment.intro).slice(0, 2000),
                            source: 'moodlews',
                            kind: 'due'
                        });
                    });
                });
                if (window.cheeseForkTasks) {
                    window.cheeseForkTasks.importAssignments(assignments);
                }
                return null;
            }, function () {
                return null;
            });
        }).then(function () {
            data.lastSync = now;
            data.lastError = null;
            state.syncing = false;
            saveData(data);
            configureBackground(data);
            if (interactive) {
                toast('Moodle סונכרן: ' + data.courses.length + ' קורסים, ' + countUnread() + ' פריטים חדשים');
            }
            $(document).trigger('cheesefork:moodle-synced');
            return data;
        }).catch(function (error) {
            state.syncing = false;
            var latest = loadData();
            if (error && (error.errorcode === 'invalidtoken' || error.errorcode === 'accessexception')) {
                latest.token = null;
                latest.lastError = 'ההתחברות ל-Moodle פגה, יש להתחבר מחדש.';
            } else {
                latest.lastError = 'הסנכרון עם Moodle נכשל: ' + (error && error.message);
            }
            saveData(latest);
            if (interactive) {
                toast(latest.lastError);
            }
            return null;
        });
    }

    function autoSync() {
        var data = loadData();
        if (!data.token) {
            return;
        }
        if (data.lastSync && Date.now() - data.lastSync < SYNC_INTERVAL_MS) {
            return;
        }
        sync(false);
    }

    // ---------------------------------------------------------------------
    // Queries
    // ---------------------------------------------------------------------

    function countUnread() {
        return loadData().newKeys.length;
    }

    function getNewItems() {
        var data = loadData();
        var byKey = {};
        data.items.forEach(function (item) {
            byKey[item.key] = item;
        });
        return data.newKeys.map(function (entry) {
            var item = byKey[entry.key];
            return item ? $.extend({foundAt: entry.foundAt}, item) : null;
        }).filter(Boolean).sort(function (a, b) {
            return b.timemodified - a.timemodified;
        });
    }

    function markAllSeen() {
        var data = loadData();
        data.newKeys = [];
        saveData(data);
    }

    function getCourseItems(course) {
        return loadData().items.filter(function (item) {
            return item.course === course;
        });
    }

    function lessonKind(typeText) {
        if (/הרצאה/.test(typeText)) {
            return 'lecture';
        }
        if (/תרגול|תרגיל|סדנה/.test(typeText)) {
            return 'tutorial';
        }
        if (/מעבדה/.test(typeText)) {
            return 'lab';
        }
        return null;
    }

    // Recent files of the lesson's course matching its type (lecture slides
    // for a lecture, the tutorial sheet for a tutorial).
    function getMaterialsForLesson(item, limit) {
        if (!item || item.isCustom || !item.course) {
            return [];
        }
        var kind = lessonKind(item.type || '');
        var cutoff = Date.now() - RECENT_DAYS * 24 * 3600 * 1000;
        var items = getCourseItems(item.course).filter(function (entry) {
            return entry.filename && entry.timemodified > cutoff;
        });
        var matching = kind ? items.filter(function (entry) {
            return entry.kind === kind;
        }) : [];
        if (matching.length === 0) {
            matching = items.filter(function (entry) {
                return entry.kind !== 'homework' && entry.kind !== 'solution';
            });
        }
        return matching.slice(0, limit || 3);
    }

    // Compact text for the AI helper.
    function getRecentMaterialsText() {
        var data = loadData();
        if (!data.token || data.items.length === 0) {
            return '';
        }
        var cutoff = Date.now() - RECENT_DAYS * 24 * 3600 * 1000;
        var lines = [];
        data.courses.forEach(function (course) {
            var items = data.items.filter(function (item) {
                return item.courseId === course.id && item.timemodified > cutoff;
            }).slice(0, 10);
            if (items.length === 0) {
                return;
            }
            lines.push('קורס ' + (course.course ? course.course + ' ' : '') + course.fullname + ':');
            items.forEach(function (item) {
                lines.push('- ' + (KIND_LABELS[item.kind] || '') + ': ' + item.name +
                    (item.filename && item.filename !== item.name ? ' (' + item.filename + ')' : '') +
                    (item.section ? ' | ' + item.section : '') +
                    ' | ' + moment(item.timemodified).format('DD/MM') + ' | ' + item.url);
            });
        });
        return lines.join('\n');
    }

    // ---------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------

    function renderAll() {
        state.containers = state.containers.filter(function (container) {
            return $.contains(document.body, container[0]);
        });
        state.containers.forEach(function (container) {
            renderFeed(container);
        });
    }

    function makeItemRow(item, options) {
        options = options || {};
        var row = $('<div class="cf-moodle-item"></div>');
        row.append($('<i class="fas fa-fw cf-moodle-icon"></i>').addClass(KIND_ICONS[item.kind] || 'fa-file'));
        var body = $('<div class="cf-moodle-body"></div>');
        body.append($('<div class="cf-moodle-name"></div>').text(item.name + (item.filename && item.filename !== item.name ? ' · ' + item.filename : '')));
        var meta = [];
        if (!options.hideCourse) {
            meta.push((item.courseName || '').replace(/^\d{6,10}\s*[-–:]\s*/, '').slice(0, 30));
        }
        if (item.section) {
            meta.push(item.section.slice(0, 30));
        }
        meta.push(KIND_LABELS[item.kind] || '');
        meta.push(moment(item.timemodified).format('DD/MM HH:mm'));
        body.append($('<div class="cf-moodle-meta"></div>').text(meta.filter(Boolean).join(' · ')));
        row.append(body);
        row.append($('<a class="btn btn-sm btn-outline-primary cf-moodle-open" target="_blank" rel="noopener"></a>')
            .prop('href', item.url)
            .html(item.filename ? '<i class="fas fa-download"></i>' : '<i class="fas fa-external-link-alt"></i>')
            .click(function () {
                trackEvent('moodle-open-item');
            }));
        return row;
    }

    function renderFeed(container) {
        if (state.containers.indexOf(container) === -1) {
            state.containers.push(container);
        }
        container.empty().addClass('cf-moodle-feed');
        var data = loadData();

        if (!data.token) {
            container.append($('<div class="cf-moodle-connect"></div>').append(
                $('<span class="cf-mobile-small text-muted">חברו את חשבון ה-Moodle כדי לראות חומרים חדשים, קבצים לכל שיעור ומטלות עם קישורים.</span>'),
                $('<button type="button" class="btn btn-sm btn-outline-primary mt-1"><i class="fas fa-link"></i> חיבור ל-Moodle</button>').click(showConnectDialog)));
            return;
        }

        var header = $('<div class="cf-moodle-header"></div>');
        var unread = getNewItems();
        header.append($('<span class="font-weight-bold"></span>').text('חדש ב-Moodle' + (unread.length ? ' (' + unread.length + ')' : '')));
        var actions = $('<span class="cf-moodle-header-actions"></span>');
        actions.append($('<button type="button" class="btn btn-sm btn-link"></button>')
            .html(state.syncing ? '<i class="fas fa-sync-alt fa-spin"></i>' : '<i class="fas fa-sync-alt"></i>')
            .prop('disabled', state.syncing)
            .click(function () {
                sync(true);
            }));
        if (unread.length > 0) {
            actions.append($('<button type="button" class="btn btn-sm btn-link">סמן כנקרא</button>').click(markAllSeen));
        }
        header.append(actions);
        container.append(header);

        if (data.lastError) {
            container.append($('<div class="cf-mobile-small text-danger"></div>').text(data.lastError));
        }

        if (unread.length === 0) {
            container.append($('<div class="cf-mobile-small text-muted"></div>').text(
                'אין פריטים חדשים' + (data.lastSync ? ' · נבדק ' + moment(data.lastSync).format('DD/MM HH:mm') : '') + '.'));
            return;
        }

        unread.slice(0, 30).forEach(function (item) {
            container.append(makeItemRow(item));
        });
    }

    function showFeedDialog() {
        var container = $('<div></div>');
        BootstrapDialog.show({
            title: 'חדש ב-Moodle',
            message: container,
            onshown: function () {
                renderFeed(container);
            },
            buttons: [{
                label: 'סגור',
                cssClass: 'btn-primary',
                action: function (dialog) {
                    dialog.close();
                }
            }]
        });
    }

    function showCourseMaterials(course, lessonType) {
        trackEvent('moodle-course-materials');
        var data = loadData();
        var container = $('<div></div>');
        var title = api.courseManager.doesExist(course) ? api.courseManager.getGeneralInfo(course)['שם מקצוע'] : course;

        if (!data.token) {
            container.append('<p>חברו את Moodle כדי לראות את חומרי הקורס.</p>');
            container.append($('<button type="button" class="btn btn-primary btn-sm">חיבור ל-Moodle</button>').click(function () {
                dialog.close();
                showConnectDialog();
            }));
        } else {
            var items = getCourseItems(course);
            var moodleCourse = data.courses.filter(function (entry) {
                return entry.course === course;
            })[0];
            if (!moodleCourse) {
                container.append('<p class="text-muted">הקורס לא נמצא בין הקורסים שלכם ב-Moodle (או שמספר הקורס לא מופיע בשם הקורס שם).</p>');
            }
            if (lessonType) {
                var forLesson = getMaterialsForLesson({course: course, type: lessonType}, 4);
                if (forLesson.length > 0) {
                    container.append($('<h6 class="cf-moodle-subtitle"></h6>').text('חומר ל' + lessonType.replace(/\s*\d+$/, '') + ' הקרוב'));
                    forLesson.forEach(function (item) {
                        container.append(makeItemRow(item, {hideCourse: true}));
                    });
                }
            }
            if (items.length > 0) {
                container.append($('<h6 class="cf-moodle-subtitle"></h6>').text('כל החומרים (חדש למעלה)'));
                items.slice(0, 60).forEach(function (item) {
                    container.append(makeItemRow(item, {hideCourse: true}));
                });
            } else if (moodleCourse) {
                container.append('<p class="text-muted">אין עדיין קבצים בקורס זה.</p>');
            }
            if (moodleCourse) {
                container.append($('<div class="mt-2"></div>').append(
                    $('<a target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> פתיחת הקורס ב-Moodle</a>')
                        .prop('href', data.siteUrl + '/course/view.php?id=' + moodleCourse.id)));
            }
        }

        var dialog = BootstrapDialog.show({
            title: 'Moodle - ' + title,
            message: container,
            buttons: [{
                label: 'סגור',
                cssClass: 'btn-primary',
                action: function (d) {
                    d.close();
                }
            }]
        });
    }

    function showConnectDialog() {
        trackEvent('moodle-connect-open');
        var data = loadData();

        var siteInput = $('<input type="url" class="form-control form-control-sm" dir="ltr">').val(data.siteUrl);
        var tokenInput = $('<input type="password" class="form-control form-control-sm" dir="ltr" placeholder="הדביקו כאן מפתח (token)">');
        var message = $('<div></div>');

        if (data.token) {
            message.append(
                $('<p></p>').text('מחובר ל-Moodle' + (data.userName ? ' בתור ' + data.userName : '') + '. ' +
                    data.courses.length + ' קורסים' + (data.lastSync ? ', סונכרן ' + moment(data.lastSync).format('DD/MM HH:mm') : '') + '.'),
                $('<div class="cf-mobile-small text-muted"></div>').text(
                    'קורסים שזוהו: ' + (data.courses.map(function (course) {
                        return (course.course ? '✓ ' : '? ') + course.fullname.slice(0, 40);
                    }).join(' | ') || 'אין')));
            if (platform.plugin('MoodleBackground')) {
                var backgroundToggle = $('<input class="form-check-input" type="checkbox" id="cf-moodle-background">').prop('checked', data.background !== false);
                backgroundToggle.on('change', function () {
                    setBackgroundEnabled(this.checked);
                });
                message.append($('<div class="form-check mt-2"></div>').append(backgroundToggle,
                    '<label class="form-check-label small" for="cf-moodle-background">בדיקה ברקע כל חצי שעה והתראה על קבצים ותרגילי בית חדשים</label>'));
            }
        } else {
            message.append(
                '<p>חיבור לחשבון ה-Moodle שלכם מאפשר לאפליקציה לראות חומרים חדשים, קבצים לכל שיעור ומטלות עם קישורים ישירים. ' +
                'האפליקציה מקבלת מפתח גישה אישי (כמו אפליקציית Moodle הרשמית), שנשמר במכשיר זה בלבד.</p>',
                $('<div class="form-group"></div>').append('<label class="small mb-0">כתובת ה-Moodle</label>', siteInput),
                $('<button type="button" class="btn btn-primary btn-block mb-2"><i class="fas fa-sign-in-alt"></i> התחברות דרך Moodle (הזדהות טכניונית)</button>').click(function () {
                    var latest = loadData();
                    latest.siteUrl = siteInput.val().trim().replace(/\/$/, '') || DEFAULT_SITE;
                    saveData(latest);
                    dialog.close();
                    if (platform.isNative) {
                        connectViaBrowser();
                    } else {
                        BootstrapDialog.show({
                            title: 'חיבור ל-Moodle',
                            message: 'ההתחברות האוטומטית עובדת באפליקציה. בדפדפן אפשר להדביק מפתח ידנית: ב-Moodle פתחו "העדפות" ← "מפתחות אבטחה" (Security keys), ' +
                                'העתיקו את המפתח של "Moodle mobile web service" והדביקו אותו בחלון החיבור.',
                            size: BootstrapDialog.SIZE_SMALL
                        });
                    }
                }),
                $('<details class="cf-mobile-small"><summary>או הדבקת מפתח ידנית</summary></details>').append(
                    $('<div class="mt-1"></div>').append(
                        $('<div class="text-muted mb-1"></div>').html('ב-Moodle: העדפות ← חשבון משתמש ← <a href="' + data.siteUrl + '/user/managetoken.php" target="_blank" rel="noopener">מפתחות אבטחה</a> ← המפתח של Moodle mobile web service.'),
                        tokenInput)));
        }

        var buttons = [];
        if (data.token) {
            buttons.push({
                label: 'סנכרון',
                cssClass: 'btn-primary',
                action: function (d) {
                    d.close();
                    sync(true);
                }
            }, {
                label: 'ניתוק',
                cssClass: 'btn-outline-danger',
                action: function (d) {
                    disconnect();
                    d.close();
                }
            });
        } else {
            buttons.push({
                label: 'חיבור עם המפתח',
                cssClass: 'btn-primary',
                action: function (d) {
                    var token = tokenInput.val().trim();
                    if (!token) {
                        tokenInput.addClass('is-invalid');
                        return;
                    }
                    d.close();
                    connectWithToken(token, null, siteInput.val().trim().replace(/\/$/, '') || DEFAULT_SITE);
                }
            });
        }
        buttons.push({
            label: 'ייבוא לוח שנה (ics)',
            action: function (d) {
                d.close();
                if (window.cheeseForkTasks) {
                    window.cheeseForkTasks.showMoodleDialog();
                }
            }
        }, {
            label: 'סגור',
            action: function (d) {
                d.close();
            }
        });

        var dialog = BootstrapDialog.show({
            title: 'חיבור ל-Moodle',
            message: message,
            buttons: buttons
        });
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function toast(text) {
        if (mobile) {
            mobile.showToast(text);
        }
    }

    function trackEvent(name) {
        if (typeof gtag === 'function') {
            gtag('event', name);
        }
    }

    // Compact MD5 (RFC 1321), used to verify the SSO handoff like the Moodle app does.
    function md5(input) {
        function toBytes(str) {
            var bytes = [];
            var encoded = unescape(encodeURIComponent(str));
            for (var i = 0; i < encoded.length; i++) {
                bytes.push(encoded.charCodeAt(i));
            }
            return bytes;
        }
        function add(a, b) {
            return (a + b) & 0xFFFFFFFF;
        }
        function rotl(x, c) {
            return (x << c) | (x >>> (32 - c));
        }
        var K = [];
        for (var i = 0; i < 64; i++) {
            K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
        }
        var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
            5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
            4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
            6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

        var bytes = toBytes(input);
        var bitLength = bytes.length * 8;
        bytes.push(0x80);
        while (bytes.length % 64 !== 56) {
            bytes.push(0);
        }
        for (var b = 0; b < 8; b++) {
            bytes.push(Math.floor(bitLength / Math.pow(2, 8 * b)) & 0xFF);
        }

        var a0 = 0x67452301, b0 = 0xEFCDAB89, c0 = 0x98BADCFE, d0 = 0x10325476;
        for (var offset = 0; offset < bytes.length; offset += 64) {
            var M = [];
            for (var j = 0; j < 16; j++) {
                M[j] = bytes[offset + j * 4] | (bytes[offset + j * 4 + 1] << 8) |
                    (bytes[offset + j * 4 + 2] << 16) | (bytes[offset + j * 4 + 3] << 24);
            }
            var A = a0, B = b0, C = c0, D = d0;
            for (var k = 0; k < 64; k++) {
                var F, g;
                if (k < 16) {
                    F = (B & C) | (~B & D);
                    g = k;
                } else if (k < 32) {
                    F = (D & B) | (~D & C);
                    g = (5 * k + 1) % 16;
                } else if (k < 48) {
                    F = B ^ C ^ D;
                    g = (3 * k + 5) % 16;
                } else {
                    F = C ^ (B | ~D);
                    g = (7 * k) % 16;
                }
                var temp = D;
                D = C;
                C = B;
                B = add(B, rotl(add(add(A, F), add(K[k], M[g])), S[k]));
                A = temp;
            }
            a0 = add(a0, A);
            b0 = add(b0, B);
            c0 = add(c0, C);
            d0 = add(d0, D);
        }

        function hex(n) {
            var text = '';
            for (var i = 0; i < 4; i++) {
                text += ('0' + ((n >>> (i * 8)) & 0xFF).toString(16)).slice(-2);
            }
            return text;
        }
        return hex(a0) + hex(b0) + hex(c0) + hex(d0);
    }

    function init() {
        api = window.cheeseFork;
        mobile = window.cheeseForkMobile;

        var app = platform.plugin('App');
        if (app) {
            app.addListener('appUrlOpen', function (event) {
                handleAppUrl(event && event.url);
            });
            app.getLaunchUrl().then(function (result) {
                if (result && result.url) {
                    handleAppUrl(result.url);
                }
            }).catch(function () {});
            app.addListener('appStateChange', function (appState) {
                if (appState.isActive) {
                    autoSync();
                }
            });
        }

        autoSync();
    }

    window.cheeseForkMoodle = {
        isConnected: isConnected,
        sync: sync,
        connectViaBrowser: connectViaBrowser,
        connectWithToken: connectWithToken,
        handleAppUrl: handleAppUrl,
        disconnect: disconnect,
        countUnread: countUnread,
        getNewItems: getNewItems,
        markAllSeen: markAllSeen,
        getCourseItems: getCourseItems,
        getMaterialsForLesson: getMaterialsForLesson,
        getRecentMaterialsText: getRecentMaterialsText,
        renderFeed: renderFeed,
        showFeedDialog: showFeedDialog,
        showCourseMaterials: showCourseMaterials,
        showConnectDialog: showConnectDialog,
        setBackgroundEnabled: setBackgroundEnabled,
        md5: md5,
        KIND_LABELS: KIND_LABELS
    };

    $(function () {
        if (window.cheeseForkMobile) {
            init();
        } else {
            $(document).one('cheesefork:mobile-ready', init);
        }
    });
})();
