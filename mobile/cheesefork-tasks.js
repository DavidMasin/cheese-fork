'use strict';

/* global moment, BootstrapDialog, gtag */

// Tasks (מטלות): deadlines imported from Moodle's calendar export plus
// manual tasks, stored on the device only. Exposes window.cheeseForkTasks
// for the mobile layer (now card, reminders, widget) and the app shell.

(function () {
    var STORAGE_KEY = 'cheeseForkTasks';
    var SYNC_INTERVAL_MS = 60 * 60 * 1000;

    var platform = window.cheeseForkPlatform || {isNative: false, plugin: function () { return null; }};
    var api = null;
    var mobile = null;

    var state = {
        filter: 'open',
        containers: [],
        syncing: false
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
        data.tasks = data.tasks || {};
        data.moodle = data.moodle || {icsUrl: null, lastSync: null, lastError: null, lastCount: 0};
        return data;
    }

    function saveData(data) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // Ignore.
        }
        $(document).trigger('cheesefork:tasks-changed');
        renderAll();
    }

    // ---------------------------------------------------------------------
    // Tasks model
    // ---------------------------------------------------------------------

    function parseDue(task) {
        if (!task.due) {
            return null;
        }
        var date = new Date(task.due);
        return isNaN(date.getTime()) ? null : date;
    }

    function daysUntil(date) {
        var now = new Date();
        var a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var b = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        return Math.round((b - a) / (24 * 3600 * 1000));
    }

    function getTasks(filter) {
        var data = loadData();
        var tasks = Object.keys(data.tasks).map(function (id) {
            var task = data.tasks[id];
            task.dueDate = parseDue(task);
            return task;
        });

        if (filter === 'open') {
            tasks = tasks.filter(function (task) {
                return !task.done;
            });
        } else if (filter === 'done') {
            tasks = tasks.filter(function (task) {
                return task.done;
            });
        }

        tasks.sort(function (a, b) {
            if (!a.dueDate && !b.dueDate) {
                return (a.title || '').localeCompare(b.title || '');
            }
            if (!a.dueDate) {
                return 1;
            }
            if (!b.dueDate) {
                return -1;
            }
            return a.dueDate - b.dueDate;
        });

        return tasks;
    }

    // Open tasks with a due date from now on, nearest first.
    function getUpcoming() {
        var now = Date.now();
        return getTasks('open').filter(function (task) {
            return task.dueDate && task.dueDate.getTime() >= now - 60 * 1000;
        });
    }

    function setDone(id, done) {
        var data = loadData();
        if (data.tasks[id]) {
            data.tasks[id].done = done;
            data.tasks[id].doneAt = done ? Date.now() : null;
            saveData(data);
        }
    }

    function removeTask(id) {
        var data = loadData();
        delete data.tasks[id];
        saveData(data);
    }

    function upsertTask(task) {
        var data = loadData();
        data.tasks[task.id] = $.extend({}, data.tasks[task.id] || {}, task);
        saveData(data);
    }

    // ---------------------------------------------------------------------
    // Moodle calendar (iCalendar) import
    // ---------------------------------------------------------------------

    function unfoldIcs(text) {
        return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
    }

    function unescapeIcs(value) {
        return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    }

    function parseIcsDate(value, params) {
        var match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
        if (!match) {
            return null;
        }
        var year = parseInt(match[1], 10);
        var month = parseInt(match[2], 10) - 1;
        var day = parseInt(match[3], 10);
        if (match[4] === undefined || /VALUE=DATE(?![-])/i.test(params)) {
            // All-day event: treat as the end of that day.
            return new Date(year, month, day, 23, 59);
        }
        var hour = parseInt(match[4], 10);
        var minute = parseInt(match[5], 10);
        var second = parseInt(match[6] || '0', 10);
        if (match[7] === 'Z') {
            return new Date(Date.UTC(year, month, day, hour, minute, second));
        }
        return new Date(year, month, day, hour, minute, second);
    }

    function parseIcs(text) {
        var lines = unfoldIcs(text).split('\n');
        var events = [];
        var current = null;

        lines.forEach(function (line) {
            if (line === 'BEGIN:VEVENT') {
                current = {};
                return;
            }
            if (line === 'END:VEVENT') {
                if (current) {
                    events.push(current);
                }
                current = null;
                return;
            }
            if (!current) {
                return;
            }
            var colon = line.indexOf(':');
            if (colon === -1) {
                return;
            }
            var nameAndParams = line.slice(0, colon);
            var value = line.slice(colon + 1);
            var semicolon = nameAndParams.indexOf(';');
            var name = (semicolon === -1 ? nameAndParams : nameAndParams.slice(0, semicolon)).toUpperCase();
            var params = semicolon === -1 ? '' : nameAndParams.slice(semicolon + 1);

            switch (name) {
            case 'UID':
                current.uid = value.trim();
                break;
            case 'SUMMARY':
                current.summary = unescapeIcs(value).trim();
                break;
            case 'DESCRIPTION':
                current.description = unescapeIcs(value).trim();
                break;
            case 'CATEGORIES':
                current.categories = unescapeIcs(value).trim();
                break;
            case 'DTSTART':
                current.start = parseIcsDate(value, params);
                break;
            case 'DTEND':
                current.end = parseIcsDate(value, params);
                break;
            case 'URL':
                current.url = value.trim();
                break;
            default:
                break;
            }
        });

        return events;
    }

    // Moodle's event titles: "<name> is due", "יש להגיש <name>", "<name> opens"...
    function classifyMoodleEvent(summary) {
        var title = summary;
        var kind = 'due';

        var patterns = [
            [/\s+is due$/i, 'due'],
            [/\s+(?:should be completed|needs grading)$/i, 'due'],
            [/^(?:יש להגיש(?: את)?|להגשה:?|מועד הגשה:?)\s+/, 'due'],
            [/\s+(?:-\s+)?(?:מועד הגשה|תאריך הגשה|להגשה)$/, 'due'],
            [/\s+closes$/i, 'close'],
            [/\s+(?:נסגר|נסגרת|ייסגר|סגירה)$/, 'close'],
            [/\s+opens$/i, 'open'],
            [/\s+(?:נפתח|נפתחת|ייפתח|פתיחה)$/, 'open'],
            [/\s+starts$/i, 'open'],
            [/\s+(?:מתחיל|מתחילה)$/, 'open']
        ];

        for (var i = 0; i < patterns.length; i++) {
            if (patterns[i][0].test(title)) {
                title = title.replace(patterns[i][0], '').trim();
                kind = patterns[i][1];
                break;
            }
        }

        return {title: title || summary, kind: kind};
    }

    function matchCourse(text) {
        if (!api || !text) {
            return null;
        }
        var numbers = text.match(/\d{6,10}/g) || [];
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

    function moodleHost(url) {
        var match = /^https?:\/\/([^/]+)/i.exec(url || '');
        return match ? match[1] : 'moodle.technion.ac.il';
    }

    function importIcsText(text, sourceUrl) {
        var events = parseIcs(text);
        if (events.length === 0 && text.indexOf('BEGIN:VCALENDAR') === -1) {
            throw new Error('not-ics');
        }

        var data = loadData();
        var host = moodleHost(sourceUrl);
        var imported = 0;
        var seen = {};

        events.forEach(function (event) {
            if (!event.uid || !event.summary) {
                return;
            }
            var classified = classifyMoodleEvent(event.summary);
            if (classified.kind === 'open') {
                return;
            }

            var id = 'moodle:' + event.uid;
            seen[id] = true;
            var due = event.start || event.end;
            var course = matchCourse(event.categories) || matchCourse(event.summary) || matchCourse(event.description);
            var courseName = event.categories || (course ? api.courseManager.getGeneralInfo(course)['שם מקצוע'] : '');
            var eventId = /^(\d+)@/.exec(event.uid);
            var url = event.url || (due
                ? 'https://' + host + '/calendar/view.php?view=day&time=' + Math.floor(due.getTime() / 1000)
                : 'https://' + host + '/calendar/view.php?view=upcoming');

            var existing = data.tasks[id] || {};
            data.tasks[id] = {
                id: id,
                title: classified.title,
                kind: classified.kind,
                raw: event.summary,
                course: course,
                courseName: courseName,
                due: due ? moment(due).format('YYYY-MM-DDTHH:mm') : null,
                notes: existing.notes || '',
                description: (event.description || '').slice(0, 2000),
                url: url,
                moodleEventId: eventId ? eventId[1] : null,
                source: 'moodle',
                done: existing.done || false,
                doneAt: existing.doneAt || null,
                created: existing.created || Date.now()
            };
            imported++;
        });

        // Moodle events which disappeared from the export (deleted, or moved
        // out of the export window) are kept but flagged.
        Object.keys(data.tasks).forEach(function (id) {
            var task = data.tasks[id];
            if (task.source === 'moodle') {
                task.missing = !seen[id];
            }
        });

        data.moodle.lastSync = Date.now();
        data.moodle.lastError = null;
        data.moodle.lastCount = imported;
        saveData(data);
        return imported;
    }

    function fetchText(url) {
        var http = platform.plugin('CapacitorHttp');
        if (http) {
            return http.get({url: url, responseType: 'text', connectTimeout: 20000, readTimeout: 30000}).then(function (response) {
                if (response.status !== 200 || typeof response.data !== 'string') {
                    throw new Error('HTTP ' + response.status);
                }
                return response.data;
            });
        }
        return fetch(url).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.text();
        });
    }

    function syncMoodle(interactive) {
        var data = loadData();
        if (!data.moodle.icsUrl || state.syncing) {
            return Promise.resolve(null);
        }
        state.syncing = true;
        renderAll();

        return fetchText(data.moodle.icsUrl).then(function (text) {
            var count = importIcsText(text, data.moodle.icsUrl);
            state.syncing = false;
            renderAll();
            if (interactive) {
                toast('סונכרנו ' + count + ' מטלות מ-Moodle');
            }
            return count;
        }).catch(function (error) {
            state.syncing = false;
            var latest = loadData();
            latest.moodle.lastError = error && error.message === 'not-ics'
                ? 'הקישור לא החזיר לוח שנה. בדקו שזה קישור הייצוא של Moodle.'
                : 'הסנכרון נכשל' + (platform.isNative ? '' : ' (דפדפנים חוסמים גישה ישירה ל-Moodle; השתמשו באפליקציה או הדביקו את תוכן הקובץ)') + '.';
            saveData(latest);
            if (interactive) {
                toast(latest.moodle.lastError);
            }
            return null;
        });
    }

    function autoSync() {
        var data = loadData();
        if (!data.moodle.icsUrl || !platform.isNative) {
            return;
        }
        if (data.moodle.lastSync && Date.now() - data.moodle.lastSync < SYNC_INTERVAL_MS) {
            return;
        }
        syncMoodle(false);
    }

    // ---------------------------------------------------------------------
    // UI: panel
    // ---------------------------------------------------------------------

    function renderAll() {
        state.containers = state.containers.filter(function (container) {
            return $.contains(document.body, container[0]);
        });
        state.containers.forEach(function (container) {
            renderPanel(container);
        });
    }

    function renderPanel(container) {
        if (state.containers.indexOf(container) === -1) {
            state.containers.push(container);
        }
        container.empty().addClass('cf-tasks');

        var data = loadData();

        // Toolbar.
        var toolbar = $('<div class="cf-tasks-toolbar"></div>');
        toolbar.append($('<button type="button" class="btn btn-sm btn-primary"><i class="fas fa-plus"></i> מטלה</button>').click(showAddDialog));
        var syncButton = $('<button type="button" class="btn btn-sm btn-outline-secondary"></button>')
            .html(state.syncing ? '<i class="fas fa-sync-alt fa-spin"></i> מסנכרן...' : '<i class="fas fa-sync-alt"></i> Moodle')
            .prop('disabled', state.syncing)
            .click(function () {
                if (data.moodle.icsUrl) {
                    trackEvent('tasks-sync');
                    syncMoodle(true);
                } else {
                    showMoodleDialog();
                }
            });
        toolbar.append(syncButton);
        toolbar.append($('<button type="button" class="btn btn-sm btn-outline-secondary" title="הגדרות Moodle"><i class="fas fa-cog"></i></button>').click(showMoodleDialog));
        container.append(toolbar);

        // Status line.
        var status = $('<div class="cf-tasks-status cf-mobile-small text-muted"></div>');
        if (data.moodle.lastError) {
            status.addClass('text-danger').removeClass('text-muted').text(data.moodle.lastError);
        } else if (data.moodle.lastSync) {
            status.text('Moodle סונכרן ' + moment(data.moodle.lastSync).format('DD/MM HH:mm') + ' · ' + data.moodle.lastCount + ' מטלות');
        } else if (!data.moodle.icsUrl) {
            status.text('חברו את לוח השנה של Moodle כדי לייבא מועדי הגשה אוטומטית.');
        }
        container.append(status);

        // Filter chips.
        var filters = $('<div class="cf-tasks-filters"></div>');
        [['open', 'פתוחות'], ['done', 'הושלמו'], ['all', 'הכל']].forEach(function (filter) {
            filters.append($('<button type="button" class="btn btn-sm"></button>')
                .addClass(state.filter === filter[0] ? 'btn-secondary' : 'btn-outline-secondary')
                .text(filter[1])
                .click(function () {
                    state.filter = filter[0];
                    renderAll();
                }));
        });
        container.append(filters);

        // Groups.
        var tasks = getTasks(state.filter);
        if (tasks.length === 0) {
            container.append($('<div class="cf-mobile-empty"></div>').text(
                state.filter === 'done' ? 'עדיין לא סומנו מטלות כהושלמו.' : 'אין מטלות 🎉'));
            return;
        }

        var groups = [
            {key: 'overdue', title: 'באיחור', cls: 'cf-tasks-group-overdue'},
            {key: 'today', title: 'היום', cls: 'cf-tasks-group-today'},
            {key: 'tomorrow', title: 'מחר', cls: ''},
            {key: 'week', title: 'השבוע', cls: ''},
            {key: 'later', title: 'בהמשך', cls: ''},
            {key: 'nodate', title: 'ללא תאריך', cls: ''},
            {key: 'done', title: 'הושלמו', cls: 'cf-tasks-group-done'}
        ];
        var byGroup = {};
        tasks.forEach(function (task) {
            var key;
            if (task.done) {
                key = state.filter === 'all' ? 'done' : groupOf(task);
            } else {
                key = groupOf(task);
            }
            (byGroup[key] = byGroup[key] || []).push(task);
        });

        groups.forEach(function (group) {
            var list = byGroup[group.key];
            if (!list || list.length === 0) {
                return;
            }
            var section = $('<div class="cf-tasks-group"></div>').addClass(group.cls);
            section.append($('<div class="cf-tasks-group-title"></div>').text(group.title + ' (' + list.length + ')'));
            list.forEach(function (task) {
                section.append(makeTaskRow(task));
            });
            container.append(section);
        });
    }

    function groupOf(task) {
        if (!task.dueDate) {
            return 'nodate';
        }
        var days = daysUntil(task.dueDate);
        if (task.dueDate.getTime() < Date.now()) {
            return 'overdue';
        }
        if (days === 0) {
            return 'today';
        }
        if (days === 1) {
            return 'tomorrow';
        }
        if (days <= 7) {
            return 'week';
        }
        return 'later';
    }

    function dueText(task) {
        if (!task.dueDate) {
            return '';
        }
        var date = task.dueDate;
        var dayNames = ['א\'', 'ב\'', 'ג\'', 'ד\'', 'ה\'', 'ו\'', 'ש\''];
        var text = 'יום ' + dayNames[date.getDay()] + ' ' + moment(date).format('DD/MM HH:mm');
        var days = daysUntil(date);
        if (date.getTime() < Date.now()) {
            text += ' · באיחור';
        } else if (days === 0) {
            var hours = Math.round((date.getTime() - Date.now()) / 3600000);
            text += hours <= 1 ? ' · בקרוב!' : ' · בעוד ' + hours + ' שעות';
        } else if (days === 1) {
            text += ' · מחר';
        } else {
            text += ' · בעוד ' + days + ' ימים';
        }
        return text;
    }

    function makeTaskRow(task) {
        var row = $('<div class="cf-tasks-item"></div>').toggleClass('cf-tasks-item-done', !!task.done);

        var checkbox = $('<input type="checkbox" class="cf-tasks-check">').prop('checked', !!task.done).on('change', function () {
            trackEvent(this.checked ? 'tasks-done' : 'tasks-undone');
            if (mobile) {
                mobile.hapticImpact();
            }
            setDone(task.id, this.checked);
        });
        row.append($('<label class="cf-tasks-checkwrap"></label>').append(checkbox, '<span class="cf-tasks-checkmark"></span>'));

        var body = $('<div class="cf-tasks-body"></div>');
        var title = $('<div class="cf-tasks-title"></div>').text(task.title);
        if (task.kind === 'close') {
            title.append(' ', $('<span class="badge badge-light cf-mobile-badge">נסגר</span>'));
        }
        if (task.missing) {
            title.append(' ', $('<span class="badge badge-warning cf-mobile-badge" title="לא מופיע יותר ב-Moodle">?</span>'));
        }
        body.append(title);

        var meta = $('<div class="cf-tasks-meta"></div>');
        if (task.courseName || task.course) {
            var color = task.course && api ? api.courseColorGenerator(task.course) : '#999';
            meta.append($('<span class="cf-tasks-course"></span>')
                .append($('<span class="cf-mobile-item-color"></span>').css('background-color', color))
                .append($('<span></span>').text(shortCourseName(task))));
        }
        if (task.dueDate) {
            meta.append($('<span class="cf-tasks-due"></span>').text(dueText(task)));
        }
        body.append(meta);
        if (task.notes) {
            body.append($('<div class="cf-tasks-notes cf-mobile-small"></div>').text(task.notes));
        }
        row.append(body);

        var actions = $('<div class="cf-tasks-actions"></div>');
        if (task.url) {
            actions.append($('<a class="btn btn-sm btn-link" target="_blank" rel="noopener" title="פתיחה ב-Moodle"><i class="fas fa-external-link-alt"></i></a>').prop('href', task.url));
        }
        actions.append($('<button type="button" class="btn btn-sm btn-link" title="עריכה"><i class="fas fa-pen"></i></button>').click(function () {
            showEditDialog(task);
        }));
        row.append(actions);

        return row;
    }

    function shortCourseName(task) {
        var name = task.courseName || '';
        if (task.course && api) {
            name = api.courseManager.getGeneralInfo(task.course)['שם מקצוע'];
        }
        name = name.replace(/^\d{6,10}\s*[-–:]\s*/, '');
        return name.length > 28 ? name.slice(0, 27) + '…' : name;
    }

    // ---------------------------------------------------------------------
    // UI: dialogs
    // ---------------------------------------------------------------------

    function taskForm(task) {
        var form = $('<form class="cf-tasks-form"></form>');
        var title = $('<input type="text" class="form-control" placeholder="מה צריך לעשות?" required>').val(task.title || '');
        var course = $('<select class="form-control"></select>');
        course.append('<option value="">ללא קורס</option>');
        if (api) {
            api.getSelectedCourses().forEach(function (number) {
                course.append($('<option>', {
                    value: number,
                    text: api.courseManager.getGeneralInfo(number)['שם מקצוע'],
                    selected: number === task.course
                }));
            });
            if (task.course && course.find('option[value="' + task.course + '"]').length === 0) {
                course.append($('<option>', {value: task.course, text: shortCourseName(task), selected: true}));
            }
        }
        var dueDate = $('<input type="date" class="form-control">').val(task.due ? task.due.slice(0, 10) : '');
        var dueTime = $('<input type="time" class="form-control">').val(task.due ? task.due.slice(11, 16) : '23:59');
        var notes = $('<textarea class="form-control" rows="2" placeholder="הערות"></textarea>').val(task.notes || '');

        form.append(
            $('<div class="form-group"></div>').append('<label class="small mb-0">מטלה</label>', title),
            $('<div class="form-group"></div>').append('<label class="small mb-0">קורס</label>', course),
            $('<div class="form-row"></div>').append(
                $('<div class="form-group col-7"></div>').append('<label class="small mb-0">תאריך הגשה</label>', dueDate),
                $('<div class="form-group col-5"></div>').append('<label class="small mb-0">שעה</label>', dueTime)),
            $('<div class="form-group"></div>').append('<label class="small mb-0">הערות</label>', notes));

        return {
            element: form,
            read: function () {
                var result = {
                    title: title.val().trim(),
                    course: course.val() || null,
                    courseName: course.val() ? course.find('option:selected').text() : '',
                    due: dueDate.val() ? dueDate.val() + 'T' + (dueTime.val() || '23:59') : null,
                    notes: notes.val().trim()
                };
                return result.title ? result : null;
            }
        };
    }

    function showAddDialog() {
        trackEvent('tasks-add-open');
        var form = taskForm({});
        var dialog = BootstrapDialog.show({
            title: 'מטלה חדשה',
            message: form.element,
            onshown: function () {
                form.element.find('input').first().focus();
            },
            buttons: [{
                label: 'הוספה',
                cssClass: 'btn-primary',
                action: function () {
                    var values = form.read();
                    if (!values) {
                        form.element.find('input').first().addClass('is-invalid');
                        return;
                    }
                    values.id = 'manual:' + Date.now();
                    values.source = 'manual';
                    values.done = false;
                    values.created = Date.now();
                    upsertTask(values);
                    dialog.close();
                    toast('המטלה נוספה');
                }
            }, {
                label: 'ביטול',
                action: function () {
                    dialog.close();
                }
            }]
        });
    }

    function showEditDialog(task) {
        var form = taskForm(task);
        var dialog = BootstrapDialog.show({
            title: 'עריכת מטלה',
            message: $('<div></div>').append(
                task.source === 'moodle' ? '<div class="cf-mobile-small text-muted mb-2">מטלה מ-Moodle: הכותרת והתאריך יתעדכנו בסנכרון הבא.</div>' : '',
                form.element,
                task.description ? $('<details class="cf-mobile-small"><summary>תיאור מ-Moodle</summary></details>').append($('<div class="cf-tasks-description"></div>').text(task.description)) : ''),
            buttons: [{
                label: 'שמירה',
                cssClass: 'btn-primary',
                action: function () {
                    var values = form.read();
                    if (!values) {
                        return;
                    }
                    values.id = task.id;
                    upsertTask(values);
                    dialog.close();
                }
            }, {
                label: 'מחיקה',
                cssClass: 'btn-outline-danger',
                action: function () {
                    removeTask(task.id);
                    dialog.close();
                }
            }, {
                label: 'ביטול',
                action: function () {
                    dialog.close();
                }
            }]
        });
    }

    function showMoodleDialog() {
        trackEvent('tasks-moodle-open');
        var data = loadData();

        var urlInput = $('<input type="url" class="form-control" dir="ltr" placeholder="https://moodle26.technion.ac.il/calendar/export_execute.php?...">').val(data.moodle.icsUrl || '');
        var pasteArea = $('<textarea class="form-control" rows="3" dir="ltr" placeholder="BEGIN:VCALENDAR ..."></textarea>');

        var message = $('<div></div>').append(
            '<p>Moodle יכול לייצא את לוח השנה שלכם (מועדי הגשה, בחנים) כקישור קבוע. פעם אחת:</p>' +
            '<ol class="pr-3 cf-mobile-small">' +
                '<li>פתחו ב-Moodle את <a href="https://moodle.technion.ac.il/calendar/export.php" target="_blank" rel="noopener">ייצוא לוח שנה</a> (לוח שנה ← ייצוא).</li>' +
                '<li>בחרו "כל האירועים" ו"60 הימים הקרובים" (או "השנה הנוכחית"), ולחצו "קבלת כתובת לוח שנה".</li>' +
                '<li>העתיקו את הכתובת והדביקו אותה כאן.</li>' +
            '</ol>',
            $('<div class="form-group"></div>').append('<label class="small mb-0">קישור הייצוא</label>', urlInput),
            '<div class="cf-mobile-small text-muted mb-2">הקישור מכיל מפתח אישי ונשמר במכשיר זה בלבד. המטלות מתעדכנות בכל פתיחה של האפליקציה (לכל היותר פעם בשעה).</div>',
            $('<details class="cf-mobile-small mb-2"><summary>או הדבקת תוכן קובץ לוח השנה (ics)</summary></details>').append(pasteArea));

        var buttons = [{
            label: 'שמירה וסנכרון',
            cssClass: 'btn-primary',
            action: function (dialog) {
                var pasted = pasteArea.val().trim();
                var url = urlInput.val().trim();
                var latest = loadData();

                if (pasted) {
                    try {
                        var count = importIcsText(pasted, url);
                        toast('יובאו ' + count + ' מטלות');
                    } catch (e) {
                        alert('הטקסט שהודבק אינו קובץ לוח שנה תקין.');
                        return;
                    }
                }

                if (url && !/^https?:\/\//i.test(url)) {
                    alert('הקישור צריך להתחיל ב-https://');
                    return;
                }
                latest = loadData();
                latest.moodle.icsUrl = url || null;
                if (!url) {
                    latest.moodle.lastError = null;
                }
                saveData(latest);
                dialog.close();
                if (url) {
                    syncMoodle(true);
                }
            }
        }];
        if (data.moodle.icsUrl) {
            buttons.push({
                label: 'ניתוק',
                cssClass: 'btn-outline-danger',
                action: function (dialog) {
                    var latest = loadData();
                    latest.moodle = {icsUrl: null, lastSync: null, lastError: null, lastCount: 0};
                    Object.keys(latest.tasks).forEach(function (id) {
                        if (latest.tasks[id].source === 'moodle' && !latest.tasks[id].done) {
                            delete latest.tasks[id];
                        }
                    });
                    saveData(latest);
                    dialog.close();
                }
            });
        }
        buttons.push({
            label: 'סגור',
            action: function (dialog) {
                dialog.close();
            }
        });

        BootstrapDialog.show({
            title: 'חיבור ל-Moodle',
            message: message,
            buttons: buttons
        });
    }

    function showTasksDialog() {
        var container = $('<div></div>');
        BootstrapDialog.show({
            title: 'מטלות',
            size: BootstrapDialog.SIZE_WIDE,
            message: container,
            onshown: function () {
                renderPanel(container);
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

    // ---------------------------------------------------------------------
    // Reminders (used by the mobile layer's notification sync)
    // ---------------------------------------------------------------------

    function buildNotifications(idBase) {
        var notifications = [];
        var now = Date.now();

        getUpcoming().slice(0, 25).forEach(function (task, i) {
            var due = task.dueDate;
            var title = (task.kind === 'close' ? 'נסגר' : 'להגשה') + ': ' + task.title;
            var courseText = task.course || task.courseName ? shortCourseName(task) + ' · ' : '';
            var dueTextShort = moment(due).format('DD/MM HH:mm');

            var dayBefore = new Date(due.getFullYear(), due.getMonth(), due.getDate() - 1, 18, 0);
            if (dayBefore.getTime() > now) {
                notifications.push({
                    id: idBase + i * 2,
                    title: 'מחר ' + title,
                    body: courseText + dueTextShort,
                    schedule: {at: dayBefore, allowWhileIdle: true}
                });
            }
            var morning = new Date(due.getFullYear(), due.getMonth(), due.getDate(), 8, 0);
            if (morning.getTime() > now && morning.getTime() < due.getTime()) {
                notifications.push({
                    id: idBase + i * 2 + 1,
                    title: 'היום ' + title,
                    body: courseText + dueTextShort,
                    schedule: {at: morning, allowWhileIdle: true}
                });
            }
        });

        return notifications;
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
        autoSync();
        var app = platform.plugin('App');
        if (app) {
            app.addListener('appStateChange', function (appState) {
                if (appState.isActive) {
                    autoSync();
                }
            });
        }
    }

    window.cheeseForkTasks = {
        renderPanel: renderPanel,
        showTasksDialog: showTasksDialog,
        showAddDialog: showAddDialog,
        showMoodleDialog: showMoodleDialog,
        syncMoodle: syncMoodle,
        getUpcoming: getUpcoming,
        getTasks: getTasks,
        buildNotifications: buildNotifications,
        importIcsText: importIcsText,
        parseIcs: parseIcs,
        isMoodleConnected: function () {
            return !!loadData().moodle.icsUrl;
        }
    };

    $(function () {
        if (window.cheeseForkMobile) {
            init();
        } else {
            $(document).one('cheesefork:mobile-ready', init);
        }
    });
})();
