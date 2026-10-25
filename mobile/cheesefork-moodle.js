'use strict';

/* global moment, BootstrapDialog, gtag */

// Moodle integration with a browser session. Technion's Moodle doesn't
// issue web-service tokens to apps, so the user logs in once inside the app
// (native MoodleLoginActivity, Technion SSO); the app then uses the session
// with Moodle's session-enabled AJAX functions (courses, updates, deadlines)
// and each course's standard resources page (files and activities).
// Provides:
// - a "new on Moodle" feed (items added since the last check)
// - material matched to a lesson (latest slides for a lecture, latest sheet
//   for a tutorial), opened in-app with the session
// - deadlines (homework, quizzes) with links for the tasks tab
// - a materials list for the AI helper
// Everything is stored on the device only. Android app only.

(function () {
    var STORAGE_KEY = 'cheeseForkMoodleSession';
    var OLD_STORAGE_KEY = 'cheeseForkMoodleWs';
    var DISCOVERY_SITE = 'https://moodle.technion.ac.il';
    var SYNC_INTERVAL_MS = 30 * 60 * 1000;
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
        data.courses = data.courses || [];
        data.items = data.items || [];
        data.known = data.known || {};
        data.knownEvents = data.knownEvents || {};
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

    function session() {
        return platform.plugin('MoodleSession');
    }

    function isAvailable() {
        return !!session();
    }

    function isConnected() {
        return !!loadData().connected;
    }

    // ---------------------------------------------------------------------
    // Session requests (native plugin)
    // ---------------------------------------------------------------------

    function expiredError() {
        var error = new Error('expired');
        error.expired = true;
        return error;
    }

    function ajax(methodname, args) {
        return session().ajax({methodname: methodname, args: JSON.stringify(args || {})}).then(function (result) {
            if (result.expired) {
                throw expiredError();
            }
            return JSON.parse(result.data);
        });
    }

    function getPage(url) {
        return session().getPage({url: url}).then(function (result) {
            if (result.expired) {
                throw expiredError();
            }
            return result.body || '';
        });
    }

    // Moodle's public config tells the real address (moodle.technion.ac.il
    // redirects to the yearly instance, e.g. moodle26.technion.ac.il).
    function discoverSite() {
        var url = DISCOVERY_SITE + '/lib/ajax/service-nologin.php?args=' +
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
            return String(config.wwwroot).replace(/\/$/, '');
        }).catch(function () {
            return loadData().siteUrl || DISCOVERY_SITE;
        });
    }

    // ---------------------------------------------------------------------
    // Connecting
    // ---------------------------------------------------------------------

    function connect() {
        trackEvent('moodle-login-start');
        if (!isAvailable()) {
            showAppOnlyDialog();
            return Promise.resolve(false);
        }
        return discoverSite().then(function (site) {
            return session().login({siteUrl: site}).then(function (result) {
                if (!result || !result.loggedIn) {
                    toast('ההתחברות ל-Moodle בוטלה');
                    return false;
                }
                trackEvent('moodle-login-done');
                var data = loadData();
                data.connected = true;
                data.expired = false;
                data.lastError = null;
                data.siteUrl = (result.site || site).replace(/\/$/, '');
                saveData(data);
                toast('מחובר ל-Moodle, מסנכרן...');
                return sync(true).then(function () {
                    return true;
                });
            });
        }).catch(function (error) {
            toast('ההתחברות נכשלה: ' + (error && error.message));
            return false;
        });
    }

    function disconnect() {
        var plugin = session();
        if (plugin) {
            plugin.logout().catch(function () {});
        }
        var background = platform.plugin('MoodleBackground');
        if (background) {
            background.disable().catch(function () {});
        }
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {
            // Ignore.
        }
        if (window.cheeseForkTasks) {
            window.cheeseForkTasks.removeTasksBySource('moodlews');
        }
        saveData({});
    }

    // ---------------------------------------------------------------------
    // Parsing
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
        if (/פתרון|פתרונות|solution/i.test(text)) {
            return 'solution';
        }
        if (/תרגיל[י]?\s*בית|ת"ב|\bhw\s*\d|homework|assignment|מטלה|להגשה|הגשה/i.test(text)) {
            return 'homework';
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

    // The course's resources page (course/resources.php) lists every file,
    // folder, link and page with its section; the course page itself is the
    // fallback (sections are <li class="section"> with a section name).
    function sectionOfLink(link) {
        var section = link.closest('li.section, [data-for="section"], .course-section');
        if (!section) {
            return '';
        }
        var title = section.querySelector('.sectionname, [data-for="section_title"], h3');
        return title ? title.textContent.replace(/\s+/g, ' ').trim() : '';
    }

    function parseResources(html, course, site) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var items = [];
        var seen = {};
        var lastSection = '';

        var rows = doc.querySelectorAll('table tbody tr');
        var candidates = rows.length > 0 ? Array.prototype.slice.call(rows) : [doc.body];

        candidates.forEach(function (row) {
            var isRow = row.cells && row.cells.length > 1;
            if (isRow) {
                var sectionText = row.cells[0].textContent.trim();
                if (sectionText) {
                    lastSection = sectionText;
                }
            }
            Array.prototype.forEach.call(row.querySelectorAll('a[href*="/mod/"]'), function (link) {
                var match = /\/mod\/(\w+)\/view\.php\?id=(\d+)/.exec(link.getAttribute('href') || '');
                if (!match || seen[match[2]] || match[1] === 'label') {
                    return;
                }
                seen[match[2]] = true;
                var clone = link.cloneNode(true);
                Array.prototype.forEach.call(clone.querySelectorAll('.accesshide, .sr-only, .visually-hidden'), function (hidden) {
                    hidden.remove();
                });
                var name = clone.textContent.replace(/\s+/g, ' ').trim() || 'פריט';
                var cmid = parseInt(match[2], 10);
                var section = isRow ? lastSection : sectionOfLink(link);
                items.push({
                    key: 'm' + cmid,
                    cmid: cmid,
                    modname: match[1],
                    name: name,
                    section: section,
                    url: site + '/mod/' + match[1] + '/view.php?id=' + cmid,
                    courseId: course.id,
                    course: course.course,
                    courseName: course.fullname,
                    kind: kindOf(match[1], name + ' ' + section)
                });
            });
        });

        return items;
    }

    // ---------------------------------------------------------------------
    // Sync
    // ---------------------------------------------------------------------

    function sync(interactive) {
        var data = loadData();
        if (!data.connected || !isAvailable() || state.syncing) {
            return Promise.resolve(null);
        }
        state.syncing = true;
        renderAll();

        var now = Date.now();
        var site = data.siteUrl;
        var courses = [];
        var resourceItems = [];
        var updatedCmids = {};
        var events = [];

        // "all" rather than "inprogress": before the semester starts its
        // courses are classified as future.
        return ajax('core_course_get_enrolled_courses_by_timeline_classification', {
            classification: 'all',
            limit: 0,
            offset: 0,
            sort: 'fullname'
        }).then(function (result) {
            var nowSeconds = Math.floor(now / 1000);
            courses = ((result && result.courses) || []).filter(function (course) {
                return !course.enddate || course.enddate > nowSeconds - 30 * 86400;
            }).sort(function (a, b) {
                return (b.startdate || 0) - (a.startdate || 0);
            }).slice(0, MAX_COURSES).map(function (course) {
                return {
                    id: course.id,
                    fullname: course.fullname || course.shortname || '',
                    shortname: course.shortname || '',
                    course: courseNumberIn(course.fullname) || courseNumberIn(course.shortname) || courseNumberIn(course.idnumber),
                    viewurl: course.viewurl || (site + '/course/view.php?id=' + course.id),
                    startdate: course.startdate || 0,
                    enddate: course.enddate || 0
                };
            });

            // One course at a time keeps the load on Moodle low.
            return courses.reduce(function (chain, course) {
                return chain.then(function () {
                    return getPage(site + '/course/resources.php?id=' + course.id).then(function (html) {
                        var found = parseResources(html, course, site);
                        if (found.length > 0) {
                            return found;
                        }
                        // Fall back to the course page itself.
                        return getPage(course.viewurl).then(function (page) {
                            return parseResources(page, course, site);
                        });
                    }).then(function (found) {
                        course.itemCount = found.length;
                        resourceItems = resourceItems.concat(found);
                    }, function (error) {
                        if (error && error.expired) {
                            throw error;
                        }
                        course.error = String((error && error.message) || 'error').slice(0, 80);
                    });
                }).then(function () {
                    if (!data.lastSync) {
                        return null;
                    }
                    return ajax('core_course_get_updates_since', {
                        courseid: course.id,
                        since: Math.floor(data.lastSync / 1000)
                    }).then(function (result) {
                        ((result && result.instances) || []).forEach(function (instance) {
                            if (instance.contextlevel === 'module' && (instance.updates || []).some(function (update) {
                                return update.name === 'fileareas' || update.name === 'configuration';
                            })) {
                                updatedCmids[instance.id] = true;
                            }
                        });
                    }, function (error) {
                        if (error && error.expired) {
                            throw error;
                        }
                    });
                });
            }, Promise.resolve());
        }).then(function () {
            return ajax('core_calendar_get_action_events_by_timesort', {
                timesortfrom: Math.floor(now / 1000) - 2 * 86400,
                limitnum: 50,
                limittononsuspendedevents: true
            }).then(function (result) {
                events = (result && result.events) || [];
            }, function (error) {
                if (error && error.expired) {
                    throw error;
                }
            });
        }).then(function () {
            var firstSync = !data.lastSync;
            var newKeys = data.newKeys.slice();
            var inFeed = {};
            newKeys.forEach(function (entry) {
                inFeed[entry.key] = true;
            });

            resourceItems.forEach(function (item) {
                if (data.known[item.key] === undefined) {
                    data.known[item.key] = firstSync ? 0 : now;
                    if (!firstSync && !inFeed[item.key]) {
                        newKeys.push({key: item.key, foundAt: now});
                        inFeed[item.key] = true;
                    }
                } else if (updatedCmids[item.cmid] && !inFeed[item.key]) {
                    newKeys.push({key: item.key, foundAt: now, updated: true});
                    inFeed[item.key] = true;
                }
                item.firstSeen = data.known[item.key];
            });

            var courseById = {};
            courses.forEach(function (course) {
                courseById[course.id] = course;
            });

            var eventItems = events.map(function (event) {
                var course = event.course ? courseById[event.course.id] : null;
                var key = 'e' + event.id;
                if (data.knownEvents[key] === undefined) {
                    data.knownEvents[key] = firstSync ? 0 : now;
                    if (!firstSync && !inFeed[key]) {
                        newKeys.push({key: key, foundAt: now});
                        inFeed[key] = true;
                    }
                }
                return {
                    key: key,
                    eventId: event.id,
                    cmid: null,
                    modname: event.modulename || 'event',
                    name: event.activityname || event.name,
                    section: '',
                    url: event.url || (event.action && event.action.url) || (site + '/calendar/view.php?view=upcoming'),
                    courseId: event.course ? event.course.id : null,
                    course: course ? course.course : courseNumberIn(event.course && event.course.fullname),
                    courseName: event.course ? event.course.fullname : '',
                    kind: kindOf(event.modulename, event.activityname || event.name || ''),
                    due: (event.timesort || 0) * 1000,
                    firstSeen: data.knownEvents[key]
                };
            });

            // Deadlines into the tasks tab (deduplicated with the calendar export).
            if (window.cheeseForkTasks) {
                window.cheeseForkTasks.importAssignments(eventItems.filter(function (item) {
                    return item.due;
                }).map(function (item) {
                    return {
                        id: 'moodlews:' + item.eventId,
                        title: item.name,
                        course: item.course,
                        courseName: item.courseName,
                        due: moment(item.due).format('YYYY-MM-DDTHH:mm'),
                        url: item.url,
                        description: '',
                        source: 'moodlews',
                        kind: 'due'
                    };
                }));
            }

            data.courses = courses;
            data.items = resourceItems.sort(function (a, b) {
                return b.cmid - a.cmid;
            }).concat(eventItems).slice(0, 800);
            data.newKeys = newKeys.slice(-60);
            data.lastSync = now;
            data.lastError = null;
            data.expired = false;
            state.syncing = false;
            saveData(data);
            configureBackground(data);
            if (interactive) {
                toast('Moodle סונכרן: ' + courses.length + ' קורסים, ' + resourceItems.length + ' פריטים' +
                    (countUnread() ? ', ' + countUnread() + ' חדשים' : ''));
            }
            $(document).trigger('cheesefork:moodle-synced');
            return data;
        }).catch(function (error) {
            state.syncing = false;
            var latest = loadData();
            if (error && error.expired) {
                latest.expired = true;
                latest.lastError = 'ההתחברות ל-Moodle פגה. התחברו מחדש כדי להמשיך לקבל עדכונים.';
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
        if (!data.connected || data.expired) {
            return;
        }
        if (data.lastSync && Date.now() - data.lastSync < SYNC_INTERVAL_MS) {
            return;
        }
        sync(false);
    }

    // Background checks (Android): a periodic worker uses the same session
    // and notifies about items the app hasn't seen.
    function configureBackground(data) {
        var background = platform.plugin('MoodleBackground');
        if (!background) {
            return;
        }
        if (!data.connected || data.background === false) {
            background.disable().catch(function () {});
            return;
        }
        var notifications = platform.plugin('LocalNotifications');
        var permission = notifications ? notifications.requestPermissions().catch(function () {
            return null;
        }) : Promise.resolve(null);
        permission.then(function () {
            return background.configure({
                courses: data.courses.map(function (course) {
                    return {id: course.id, name: course.fullname};
                }),
                knownCmids: data.items.filter(function (item) {
                    return item.cmid;
                }).map(function (item) {
                    return String(item.cmid);
                }),
                knownEvents: data.items.filter(function (item) {
                    return item.eventId;
                }).map(function (item) {
                    return String(item.eventId);
                }),
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
            return item ? $.extend({foundAt: entry.foundAt, updated: !!entry.updated}, item) : null;
        }).filter(Boolean).sort(function (a, b) {
            return b.foundAt - a.foundAt || (b.cmid || 0) - (a.cmid || 0);
        });
    }

    function markAllSeen() {
        var data = loadData();
        data.newKeys = [];
        saveData(data);
    }

    function getCourseItems(course) {
        return loadData().items.filter(function (item) {
            return item.course === course && item.cmid;
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

    var MATERIAL_MODULES = ['resource', 'folder', 'url', 'page', 'book'];

    // The latest material of the lesson's course matching its type (newer
    // modules have higher ids): slides for a lecture, the sheet for a tutorial.
    function getMaterialsForLesson(item, limit) {
        if (!item || item.isCustom || !item.course) {
            return [];
        }
        var kind = lessonKind(item.type || '');
        var items = getCourseItems(item.course).filter(function (entry) {
            return MATERIAL_MODULES.indexOf(entry.modname) !== -1;
        });
        var matching = kind ? items.filter(function (entry) {
            return entry.kind === kind;
        }) : [];
        if (matching.length === 0) {
            matching = items.filter(function (entry) {
                return entry.kind !== 'homework' && entry.kind !== 'solution';
            });
        }
        return matching.sort(function (a, b) {
            return b.cmid - a.cmid;
        }).slice(0, limit || 3);
    }

    // Compact text for the AI helper.
    function getRecentMaterialsText() {
        var data = loadData();
        if (!data.connected || data.items.length === 0) {
            return '';
        }
        var lines = [];
        data.courses.forEach(function (course) {
            var items = data.items.filter(function (item) {
                return item.courseId === course.id && item.cmid;
            }).slice(0, 10);
            var deadlines = data.items.filter(function (item) {
                return item.courseId === course.id && item.eventId;
            });
            if (items.length === 0 && deadlines.length === 0) {
                return;
            }
            lines.push('קורס ' + (course.course ? course.course + ' ' : '') + course.fullname + ' (מהחדש לישן):');
            items.forEach(function (item) {
                lines.push('- ' + (KIND_LABELS[item.kind] || '') + ': ' + item.name +
                    (item.section ? ' | ' + item.section : '') +
                    (item.firstSeen ? ' | נוסף ' + moment(item.firstSeen).format('DD/MM') : '') +
                    ' | ' + item.url);
            });
            deadlines.forEach(function (item) {
                lines.push('- מועד: ' + item.name + ' עד ' + moment(item.due).format('DD/MM HH:mm') + ' | ' + item.url);
            });
        });
        return lines.join('\n');
    }

    // ---------------------------------------------------------------------
    // Opening items
    // ---------------------------------------------------------------------

    function openExternal(url) {
        if (mobile && mobile.openExternal) {
            mobile.openExternal(url);
        } else {
            window.open(url, '_blank', 'noopener');
        }
    }

    // Files open inside the app with the session; everything else in the browser.
    function openUrl(url) {
        var data = loadData();
        var match = /\/mod\/resource\/view\.php\?id=(\d+)/.exec(url);
        if (!match || !data.connected || !isAvailable()) {
            openExternal(url);
            return;
        }
        trackEvent('moodle-open-file');
        toast('פותח את הקובץ...');
        session().openFile({url: data.siteUrl + '/mod/resource/view.php?id=' + match[1] + '&redirect=1'}).then(function (result) {
            if (result.expired) {
                var latest = loadData();
                latest.expired = true;
                saveData(latest);
                toast('ההתחברות ל-Moodle פגה, פותח בדפדפן');
                openExternal(url);
            } else if (result.html) {
                openExternal(url);
            }
        }).catch(function () {
            openExternal(url);
        });
    }

    // Called by the app's link handler for every external link.
    function handleLink(url) {
        var data = loadData();
        if (!data.siteUrl || url.indexOf(data.siteUrl) !== 0) {
            return false;
        }
        openUrl(url);
        return true;
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
        body.append($('<div class="cf-moodle-name"></div>').text(item.name + (item.updated ? ' (עודכן)' : '')));
        var meta = [];
        if (!options.hideCourse) {
            meta.push((item.courseName || '').replace(/^\d{6,10}\s*[-–:]\s*/, '').slice(0, 30));
        }
        if (item.section) {
            meta.push(item.section.slice(0, 30));
        }
        meta.push(KIND_LABELS[item.kind] || '');
        if (item.due) {
            meta.push('עד ' + moment(item.due).format('DD/MM HH:mm'));
        } else if (item.firstSeen) {
            meta.push('נוסף ' + moment(item.firstSeen).format('DD/MM'));
        }
        body.append($('<div class="cf-moodle-meta"></div>').text(meta.filter(Boolean).join(' · ')));
        row.append(body);
        row.append($('<button type="button" class="btn btn-sm btn-outline-primary cf-moodle-open"></button>')
            .html(item.modname === 'resource' ? '<i class="fas fa-download"></i>' : '<i class="fas fa-external-link-alt"></i>')
            .click(function () {
                trackEvent('moodle-open-item');
                openUrl(item.url);
            }));
        return row;
    }

    function renderFeed(container) {
        if (state.containers.indexOf(container) === -1) {
            state.containers.push(container);
        }
        container.empty().addClass('cf-moodle-feed');
        var data = loadData();

        if (!data.connected) {
            container.append($('<div class="cf-moodle-connect"></div>').append(
                $('<span class="cf-mobile-small text-muted">התחברו ל-Moodle כדי לראות חומרים חדשים, קבצים לכל שיעור ומועדי הגשה.</span>'),
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

        if (data.expired) {
            container.append($('<div class="cf-moodle-connect"></div>').append(
                $('<span class="cf-mobile-small text-danger"></span>').text(data.lastError || 'ההתחברות ל-Moodle פגה.'),
                $('<button type="button" class="btn btn-sm btn-primary mt-1 d-block"><i class="fas fa-sign-in-alt"></i> התחברות מחדש</button>').click(connect)));
        } else if (data.lastError) {
            container.append($('<div class="cf-mobile-small text-danger"></div>').text(data.lastError));
        }

        if (unread.length === 0) {
            container.append($('<div class="cf-mobile-small text-muted"></div>').text(
                (data.lastSync ? 'אין פריטים חדשים · נבדק ' + moment(data.lastSync).format('DD/MM HH:mm') : 'מסנכרן...')));
        } else {
            unread.slice(0, 30).forEach(function (item) {
                container.append(makeItemRow(item));
            });
        }

        // Every course with its files.
        if (data.courses.length > 0) {
            var list = $('<div class="cf-moodle-courses"></div>');
            list.append('<div class="cf-moodle-subtitle">קבצי הקורסים</div>');
            data.courses.forEach(function (course) {
                list.append($('<button type="button" class="cf-moodle-course"></button>')
                    .append(
                        $('<i class="fas fa-folder-open cf-moodle-icon"></i>'),
                        $('<span class="cf-moodle-course-name"></span>').text(shortCourseName(course.fullname)),
                        $('<span class="badge cf-mobile-badge"></span>')
                            .addClass(course.error ? 'badge-danger' : 'badge-light')
                            .text(course.error ? '!' : String(course.itemCount || 0)))
                    .click(function () {
                        showMoodleCourseMaterials(course.id);
                    }));
            });
            container.append(list);
        }
    }

    function shortCourseName(name) {
        return String(name || '')
            .replace(/\s*-\s*(חורף|אביב|קיץ)\s*-\s*/, ' · ')
            .replace(/^\d{6,10}\s*[-–:]\s*/, '')
            .slice(0, 45);
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

    // Materials of a Moodle course picked from the course list.
    function showMoodleCourseMaterials(courseId) {
        var data = loadData();
        var moodleCourse = data.courses.filter(function (entry) {
            return entry.id === courseId;
        })[0];
        if (!moodleCourse) {
            return;
        }
        var container = $('<div></div>');
        var items = data.items.filter(function (item) {
            return item.courseId === courseId && item.cmid;
        });
        var deadlines = data.items.filter(function (item) {
            return item.courseId === courseId && item.eventId;
        });
        if (moodleCourse.error) {
            container.append($('<p class="text-danger cf-mobile-small"></p>').text('קריאת הקורס נכשלה: ' + moodleCourse.error));
        }
        if (deadlines.length > 0) {
            container.append($('<h6 class="cf-moodle-subtitle">מועדי הגשה</h6>'));
            deadlines.forEach(function (item) {
                container.append(makeItemRow(item, {hideCourse: true}));
            });
        }
        if (items.length > 0) {
            container.append($('<h6 class="cf-moodle-subtitle"></h6>').text('כל החומרים (חדש למעלה)'));
            items.slice(0, 120).forEach(function (item) {
                container.append(makeItemRow(item, {hideCourse: true}));
            });
        } else if (!moodleCourse.error) {
            container.append('<p class="text-muted">לא נמצאו קבצים בקורס זה.</p>');
        }
        container.append($('<div class="mt-2"></div>').append(
            $('<button type="button" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> פתיחת הקורס ב-Moodle</button>').click(function () {
                openExternal(moodleCourse.viewurl);
            })));
        BootstrapDialog.show({
            title: shortCourseName(moodleCourse.fullname),
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

    function showCourseMaterials(course, lessonType) {
        trackEvent('moodle-course-materials');
        var data = loadData();
        var container = $('<div></div>');
        var title = api.courseManager.doesExist(course) ? api.courseManager.getGeneralInfo(course)['שם מקצוע'] : course;
        var dialog;

        if (!data.connected) {
            container.append('<p>התחברו ל-Moodle כדי לראות את חומרי הקורס.</p>');
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
                    container.append($('<h6 class="cf-moodle-subtitle"></h6>').text('החומר האחרון ל' + lessonType.replace(/\s*\d+$/, '')));
                    forLesson.forEach(function (item) {
                        container.append(makeItemRow(item, {hideCourse: true}));
                    });
                }
            }
            var deadlines = data.items.filter(function (item) {
                return item.eventId && item.course === course;
            });
            if (deadlines.length > 0) {
                container.append($('<h6 class="cf-moodle-subtitle">מועדי הגשה</h6>'));
                deadlines.forEach(function (item) {
                    container.append(makeItemRow(item, {hideCourse: true}));
                });
            }
            if (items.length > 0) {
                container.append($('<h6 class="cf-moodle-subtitle"></h6>').text('כל החומרים (חדש למעלה)'));
                items.slice(0, 80).forEach(function (item) {
                    container.append(makeItemRow(item, {hideCourse: true}));
                });
            } else if (moodleCourse) {
                container.append('<p class="text-muted">אין עדיין קבצים בקורס זה.</p>');
            }
            if (moodleCourse) {
                container.append($('<div class="mt-2"></div>').append(
                    $('<button type="button" class="btn btn-sm btn-outline-secondary"><i class="fas fa-external-link-alt"></i> פתיחת הקורס ב-Moodle</button>').click(function () {
                        openExternal(moodleCourse.viewurl);
                    })));
            }
        }

        dialog = BootstrapDialog.show({
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

    function showAppOnlyDialog() {
        BootstrapDialog.show({
            title: 'חיבור ל-Moodle',
            message: 'החיבור לחשבון ה-Moodle זמין באפליקציית האנדרואיד בלבד (ההתחברות נעשית בתוך האפליקציה). ' +
                'בדפדפן אפשר לייבא מועדי הגשה מלוח השנה של Moodle.',
            buttons: [{
                label: 'ייבוא לוח שנה (ics)',
                action: function (dialog) {
                    dialog.close();
                    if (window.cheeseForkTasks) {
                        window.cheeseForkTasks.showMoodleDialog();
                    }
                }
            }, {
                label: 'סגור',
                cssClass: 'btn-primary',
                action: function (dialog) {
                    dialog.close();
                }
            }]
        });
    }

    function showConnectDialog() {
        trackEvent('moodle-connect-open');
        if (!isAvailable()) {
            showAppOnlyDialog();
            return;
        }
        var data = loadData();
        var message = $('<div></div>');
        var buttons = [];

        if (data.connected) {
            message.append(
                $('<p></p>').text((data.expired ? 'ההתחברות ל-Moodle פגה. ' : 'מחובר ל-Moodle. ') +
                    data.courses.length + ' קורסים' + (data.lastSync ? ', סונכרן ' + moment(data.lastSync).format('DD/MM HH:mm') : '') + '.'),
                $('<div class="cf-mobile-small text-muted"></div>').text(
                    'קורסים: ' + (data.courses.map(function (course) {
                        return shortCourseName(course.fullname) +
                            ' (' + (course.error ? 'שגיאה: ' + course.error : (course.itemCount || 0) + ' פריטים') + ')';
                    }).join(' | ') || 'לא נמצאו קורסים')));
            if (platform.plugin('MoodleBackground')) {
                var backgroundToggle = $('<input class="form-check-input" type="checkbox" id="cf-moodle-background">').prop('checked', data.background !== false);
                backgroundToggle.on('change', function () {
                    setBackgroundEnabled(this.checked);
                });
                message.append($('<div class="form-check mt-2"></div>').append(backgroundToggle,
                    '<label class="form-check-label small" for="cf-moodle-background">בדיקה ברקע כל חצי שעה והתראה על קבצים ותרגילי בית חדשים</label>'));
            }
            message.append('<div class="cf-mobile-small text-muted mt-2">ההתחברות פגה מדי פעם (כמו באתר). כשזה קורה תופיע התראה, וכניסה מחדש לוקחת לחיצה אחת.</div>');
            buttons.push({
                label: data.expired ? 'התחברות מחדש' : 'סנכרון',
                cssClass: 'btn-primary',
                action: function (d) {
                    d.close();
                    if (data.expired) {
                        connect();
                    } else {
                        sync(true);
                    }
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
            message.append(
                '<p>התחברו ל-Moodle בתוך האפליקציה (הזדהות טכניונית אחידה), והאפליקציה תציג חומרים חדשים, את הקובץ האחרון לכל הרצאה ותרגול, ומועדי הגשה עם קישורים.</p>' +
                '<p class="cf-mobile-small text-muted">ההתחברות נשמרת במכשיר זה בלבד, והאפליקציה קוראת רק את הקורסים, הקבצים ומועדי ההגשה שלכם.</p>');
            buttons.push({
                label: 'התחברות ל-Moodle',
                cssClass: 'btn-primary',
                action: function (d) {
                    d.close();
                    connect();
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

        BootstrapDialog.show({
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

    function init() {
        api = window.cheeseFork;
        mobile = window.cheeseForkMobile;

        // Data of the earlier token-based version can't be used anymore.
        try {
            localStorage.removeItem(OLD_STORAGE_KEY);
        } catch (e) {
            // Ignore.
        }

        var app = platform.plugin('App');
        if (app) {
            app.addListener('appStateChange', function (appState) {
                if (appState.isActive) {
                    autoSync();
                }
            });
        }

        autoSync();
    }

    window.cheeseForkMoodle = {
        isAvailable: isAvailable,
        isConnected: isConnected,
        connect: connect,
        sync: sync,
        disconnect: disconnect,
        countUnread: countUnread,
        getNewItems: getNewItems,
        markAllSeen: markAllSeen,
        getCourseItems: getCourseItems,
        getMaterialsForLesson: getMaterialsForLesson,
        getRecentMaterialsText: getRecentMaterialsText,
        handleLink: handleLink,
        openUrl: openUrl,
        renderFeed: renderFeed,
        showFeedDialog: showFeedDialog,
        showCourseMaterials: showCourseMaterials,
        showMoodleCourseMaterials: showMoodleCourseMaterials,
        showConnectDialog: showConnectDialog,
        setBackgroundEnabled: setBackgroundEnabled,
        parseResources: parseResources,
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
