'use strict';

/* global moment, BootstrapDialog, gtag */

// The mobile layer of CheeseFork: powers the installable PWA and the native
// Android/iOS app (see MOBILE.md). It only uses the small API exposed by
// cheesefork.js as window.cheeseFork, and activates on phones, tablets, the
// installed PWA and the native app. Desktop browsers are left untouched.

(function () {
    var platform = window.cheeseForkPlatform || {
        isNative: false,
        isStandalone: false,
        os: 'web',
        plugin: function () {
            return null;
        }
    };

    var api = null;

    var DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    var DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

    var LESSON_REMINDER_ID_BASE = 500000;
    var EXAM_REMINDER_ID_BASE = 600000;
    var TASK_REMINDER_ID_BASE = 700000;
    var REMINDER_ID_END = 800000;

    var state = {
        view: 'week',
        agendaDay: null,
        daysOff: null,
        installPrompt: null,
        nowTimer: null,
        remindersSyncTimer: null,
        lastCourseCount: null,
        backButtonPressedAt: 0,
        backHandlers: []
    };

    // ---------------------------------------------------------------------
    // Bootstrap
    // ---------------------------------------------------------------------

    $(function () {
        if (window.cheeseFork) {
            onReady();
        } else {
            $(document).one('cheesefork:ready', onReady);
        }

        if (!platform.isNative) {
            registerServiceWorker();
        }
    });

    function onReady() {
        api = window.cheeseFork;

        var sidebar = $('#right-content-bar > .d-flex');
        if (sidebar.length === 0) {
            // Crawler pages (?course=...), nothing to do.
            return;
        }

        buildCard(sidebar);
        buildAgenda();

        $(document).on('cheesefork:schedule-changed', onScheduleChanged);
        $(document).on('cheesefork:tasks-changed', function () {
            renderNow();
            scheduleRemindersSync();
            scheduleDayWidgetUpdate();
        });
        $(document).on('cheesefork:moodle-changed', renderNow);

        $(window).on('resize', debounce(updateMobileMode, 200));
        updateMobileMode();

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) {
                renderNow();
            }
        });
        window.addEventListener('online', renderStatus);
        window.addEventListener('offline', renderStatus);

        loadDaysOff();
        installPromptInit();
        loginNoticeInit();
        nativeInit();

        var view = getParameterByName('view');
        if (view === 'today') {
            setView('day');
        } else {
            setView(storageGet('cfMobileView') || 'week');
        }

        // Internal API for the app shell (mobile/cheesefork-app.js).
        window.cheeseForkMobile = {
            platform: platform,
            setView: setView,
            getView: function () {
                return state.view;
            },
            shiftAgendaDay: shiftAgendaDay,
            getScheduleItems: getScheduleItems,
            getExams: getExams,
            examDaysText: examDaysText,
            formatMinutes: formatMinutes,
            makeLocationLink: makeLocationLink,
            shareSchedule: shareSchedule,
            showImportDialog: showImportDialog,
            showFreeTimeDialog: showFreeTimeDialog,
            showRemindersDialog: showRemindersDialog,
            showToast: showToast,
            hapticImpact: hapticImpact,
            registerBackHandler: function (handler) {
                state.backHandlers.push(handler);
            },
            onLessonTap: null,
            onViewChanged: null,
            DAY_NAMES: DAY_NAMES
        };
        $(document).trigger('cheesefork:mobile-ready');

        var importUserId = getParameterByName('cfimport');
        if (importUserId) {
            // Remove the parameter so that a reload doesn't import again.
            try {
                var cleanUrl = location.pathname + '?semester=' + encodeURIComponent(api.currentSemester);
                history.replaceState(null, '', cleanUrl);
            } catch (e) {
                // Ignore.
            }
            showImportDialog(importUserId);
        }
    }

    function onScheduleChanged() {
        renderNow();
        renderAgenda();

        var courseCount = api.getSelectedCourses().length;
        if (state.lastCourseCount !== null && courseCount !== state.lastCourseCount) {
            hapticImpact();
        }
        state.lastCourseCount = courseCount;

        scheduleRemindersSync();
        scheduleDayWidgetUpdate();
    }

    function isMobileMode() {
        if (platform.isNative || platform.isStandalone) {
            return true;
        }
        try {
            return window.matchMedia('(max-width: 991.98px)').matches;
        } catch (e) {
            return false;
        }
    }

    function updateMobileMode() {
        var mobile = isMobileMode();
        $('body').toggleClass('cf-mobile-mode', mobile);
        if (!mobile && state.view === 'day') {
            setView('week', true);
        }
    }

    // ---------------------------------------------------------------------
    // The "now & next" card
    // ---------------------------------------------------------------------

    function buildCard(sidebar) {
        var card = $('<div id="cf-mobile-card" class="cf-mobile-card"></div>');

        card.append('<div class="cf-mobile-status"></div>');
        card.append('<div class="cf-mobile-now"></div>');
        card.append('<div class="cf-mobile-exam"></div>');
        card.append('<div class="cf-mobile-task d-none"></div>');

        var actions = $('<div class="cf-mobile-actions"></div>');

        actions.append(makeActionButton('cf-mobile-view-button', 'fa-calendar-alt', 'תצוגת יום', function () {
            setView(state.view === 'day' ? 'week' : 'day');
        }));

        if (platform.isNative && !api.isViewingSharedSchedule()) {
            actions.append(makeActionButton('cf-mobile-reminders-button', 'fa-bell', 'תזכורות', showRemindersDialog));
        }

        actions.append(makeActionButton('cf-mobile-share-button', 'fa-share-alt', 'שיתוף', shareSchedule));

        if (!api.isViewingSharedSchedule()) {
            actions.append(makeActionButton('cf-mobile-import-button', 'fa-file-import', 'ייבוא', function () {
                showImportDialog(null);
            }));
        }

        actions.append(makeActionButton('cf-mobile-free-button', 'fa-user-friends', 'פנויים יחד', showFreeTimeDialog));

        if (!api.isViewingSharedSchedule()) {
            actions.append(makeActionButton('cf-mobile-grades-button', 'fa-graduation-cap', 'ציונים', function () {
                api.openGrades();
            }));
            actions.append(makeActionButton('cf-mobile-tasks-button', 'fa-tasks', 'מטלות', function () {
                if (window.cheeseForkTasks) {
                    window.cheeseForkTasks.showTasksDialog();
                }
            }));
            actions.append(makeActionButton('cf-mobile-ai-button', 'fa-magic', 'עוזר AI', function () {
                if (window.cheeseForkAi) {
                    window.cheeseForkAi.openAssistant();
                }
            }));
        }

        actions.append(makeActionButton('cf-mobile-install-button', 'fa-mobile-alt', 'התקנה', installApp).addClass('d-none'));

        card.append(actions);

        sidebar.prepend(card);

        renderStatus();
        renderNow();
    }

    function makeActionButton(id, icon, text, onClick) {
        return $('<button type="button" class="btn btn-sm btn-outline-secondary cf-mobile-action"></button>')
            .attr('id', id)
            .append($('<i class="fas"></i>').addClass(icon), ' ', $('<span></span>').text(text))
            .click(function () {
                trackEvent(id.replace('cf-mobile-', 'mobile-').replace('-button', ''));
                onClick();
            });
    }

    function renderStatus() {
        var status = $('#cf-mobile-card .cf-mobile-status').empty();

        if (navigator.onLine === false) {
            status.append($('<span class="badge badge-warning"><i class="fas fa-wifi"></i> אופליין</span>'));
        }

        if (platform.coursesFromCache && platform.coursesCacheDate) {
            var date = moment(platform.coursesCacheDate).format('DD/MM HH:mm');
            status.append($('<span class="badge badge-light"></span>').text('נתוני קורסים מהזיכרון (' + date + ')'));
        }

        status.toggleClass('d-none', status.children().length === 0);
    }

    // Returns the lessons and custom events of the schedule as plain objects.
    function getScheduleItems() {
        var courseManager = api.courseManager;

        return api.getSelectedEvents().map(function (event) {
            var startDay = event.start.day();
            var endDay = event.end.day();
            var item = {
                day: startDay,
                startMin: event.start.hours() * 60 + event.start.minutes(),
                endMin: endDay !== startDay ? 24 * 60 : event.end.hours() * 60 + event.end.minutes(),
                color: event.backgroundColor,
                course: event.courseNumber,
                isCustom: event.courseNumber === null
            };

            if (item.isCustom) {
                item.name = event.title.split('\n')[0];
                item.type = 'אירוע';
                item.building = '';
                item.room = '';
                item.staff = '';
            } else {
                var lesson = event.lessonData;
                var general = courseManager.getGeneralInfo(event.courseNumber);
                item.name = general['שם מקצוע'];
                item.type = courseManager.getLessonTypeAndNumber(lesson);
                item.building = lesson['בניין'] || '';
                item.room = lesson['חדר'] || '';
                item.staff = (lesson['מרצה/מתרגל'] || '').split('\n')[0];
            }

            return item;
        }).sort(function (a, b) {
            return (a.day - b.day) || (a.startMin - b.startMin) || (a.endMin - b.endMin);
        });
    }

    function formatMinutes(minutes) {
        var h = Math.floor(minutes / 60) % 24;
        var m = minutes % 60;
        return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
    }

    function formatDuration(minutes) {
        if (minutes < 60) {
            return minutes + ' דק\'';
        }
        var h = Math.floor(minutes / 60);
        var m = minutes % 60;
        var text = h === 1 ? 'שעה' : h + ' שעות';
        if (m > 0) {
            text += ' ו-' + m + ' דק\'';
        }
        return text;
    }

    function formatLocation(item) {
        if (!item.building) {
            return '';
        }
        return item.room ? item.building + ' ' + item.room : item.building;
    }

    function makeLocationLink(item) {
        var text = formatLocation(item);
        if (!text) {
            return null;
        }
        var query = 'הטכניון ' + item.building;
        return $('<a class="cf-mobile-location" target="_blank" rel="noopener"></a>')
            .prop('href', 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(query))
            .append('<i class="fas fa-map-marker-alt"></i> ', $('<span></span>').text(text))
            .click(function () {
                trackEvent('mobile-location-click');
            });
    }

    function makeItemLine(item, prefix) {
        var line = $('<div class="cf-mobile-item"></div>');
        line.append($('<span class="cf-mobile-item-color"></span>').css('background-color', item.color));
        if (prefix) {
            line.append($('<span class="cf-mobile-item-time"></span>').text(prefix), ' ');
        }
        line.append($('<span class="cf-mobile-item-name"></span>').text(item.name));
        if (!item.isCustom) {
            line.append(' ', $('<span class="cf-mobile-item-type"></span>').text(item.type));
        }
        var location = makeLocationLink(item);
        if (location) {
            line.append(' ', location);
        }
        return line;
    }

    function getSemesterStatus(now) {
        var semester = api.availableSemesters[api.currentSemester];
        if (!semester) {
            return 'active';
        }
        var start = parseLocalDate(semester.start);
        var end = parseLocalDate(semester.end);
        end.setDate(end.getDate() + 1);
        if (now < start) {
            return 'before';
        }
        if (now >= end) {
            return 'after';
        }
        return 'active';
    }

    function parseLocalDate(str) {
        var parts = str.split('-');
        return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    }

    function isDayOff(now) {
        if (!state.daysOff) {
            return false;
        }
        var key = moment(now).format('YYYY-MM-DD');
        return state.daysOff.indexOf(key) !== -1;
    }

    function findNext(items, day, nowMin) {
        // Next item today, otherwise the first item of the following days.
        for (var offset = 0; offset < 7; offset++) {
            var checkDay = (day + offset) % 7;
            var candidates = items.filter(function (item) {
                return item.day === checkDay && (offset > 0 || item.startMin > nowMin);
            });
            if (candidates.length > 0) {
                return {item: candidates[0], dayOffset: offset};
            }
        }
        return null;
    }

    function renderNow() {
        var container = $('#cf-mobile-card .cf-mobile-now');
        if (container.length === 0) {
            return;
        }
        container.empty();

        var now = new Date();
        var day = now.getDay();
        var nowMin = now.getHours() * 60 + now.getMinutes();
        var items = getScheduleItems();

        if (items.length === 0) {
            var emptyText;
            if (api.isViewingSharedSchedule()) {
                emptyText = 'המערכת ריקה';
            } else if (api.getSelectedCourses().length > 0) {
                emptyText = 'לחצו על השיעורים במערכת כדי לבחור קבוצות';
            } else {
                emptyText = 'בחרו מקצועות כדי לבנות את המערכת שלכם';
            }
            container.append($('<div class="cf-mobile-headline"></div>').text(emptyText));
            renderExam();
            return;
        }

        var semesterStatus = getSemesterStatus(now);
        var semester = api.availableSemesters[api.currentSemester];

        if (semesterStatus === 'before') {
            var start = parseLocalDate(semester.start);
            var daysToStart = daysBetween(now, start);
            container.append($('<div class="cf-mobile-headline"></div>').text(
                'הסמסטר מתחיל ב-' + moment(start).format('DD/MM') +
                (daysToStart === 1 ? ' (מחר!)' : ' (בעוד ' + daysToStart + ' ימים)')));
            var first = findNext(items, start.getDay(), -1);
            if (first) {
                container.append(makeItemLine(first.item, 'שיעור ראשון: יום ' + DAY_NAMES[first.item.day] + ' ' + formatMinutes(first.item.startMin)));
            }
        } else if (semesterStatus === 'after') {
            container.append($('<div class="cf-mobile-headline"></div>').text('הסמסטר הסתיים. בהצלחה במבחנים! 🍀'));
        } else if (isDayOff(now)) {
            container.append($('<div class="cf-mobile-headline"></div>').text('אין לימודים היום ☕'));
            var afterDayOff = findNext(items, day, 24 * 60);
            if (afterDayOff) {
                container.append(makeItemLine(afterDayOff.item, dayOffsetText(afterDayOff.dayOffset, afterDayOff.item.day) + ' ' + formatMinutes(afterDayOff.item.startMin)));
            }
        } else {
            var current = items.filter(function (item) {
                return item.day === day && item.startMin <= nowMin && nowMin < item.endMin;
            });
            var next = findNext(items, day, nowMin);

            if (current.length > 0) {
                current.forEach(function (item) {
                    var left = item.endMin - nowMin;
                    var progress = Math.round(100 * (nowMin - item.startMin) / (item.endMin - item.startMin));
                    var block = $('<div class="cf-mobile-current"></div>');
                    block.append(
                        $('<span class="badge badge-success cf-mobile-badge">עכשיו</span>'),
                        ' ',
                        makeItemLine(item).addClass('d-inline-block'));
                    block.append($('<div class="cf-mobile-small"></div>').text(
                        formatMinutes(item.startMin) + '-' + formatMinutes(item.endMin) +
                        ' · נגמר בעוד ' + formatDuration(left) +
                        (item.staff ? ' · ' + item.staff : '')));
                    block.append($('<div class="progress cf-mobile-progress"><div class="progress-bar"></div></div>')
                        .find('.progress-bar').css('width', progress + '%').end());
                    container.append(block);
                });
            } else if (next && next.dayOffset === 0) {
                container.append($('<div class="cf-mobile-headline"></div>').text(
                    'הפסקה עד ' + formatMinutes(next.item.startMin) + ' (' + formatDuration(next.item.startMin - nowMin) + ')'));
            } else if (next) {
                var doneToday = items.some(function (item) {
                    return item.day === day && item.endMin <= nowMin;
                });
                container.append($('<div class="cf-mobile-headline"></div>').text(
                    doneToday ? 'סיימתם להיום 🎉' : (day === 5 || day === 6 ? 'סוף שבוע! 🌴' : 'אין שיעורים היום 🎉')));
            }

            if (next) {
                var when;
                if (next.dayOffset === 0) {
                    when = 'הבא ' + formatMinutes(next.item.startMin);
                } else {
                    when = dayOffsetText(next.dayOffset, next.item.day) + ' ' + formatMinutes(next.item.startMin);
                }
                var nextBlock = $('<div class="cf-mobile-next"></div>');
                nextBlock.append($('<span class="badge badge-secondary cf-mobile-badge"></span>').text(when), ' ');
                nextBlock.append(makeItemLine(next.item).addClass('d-inline-block'));
                container.append(nextBlock);
            }

            // Moodle material for the current lesson, otherwise for the next one.
            var materialsFor = current.length > 0 ? current[0] : (next ? next.item : null);
            var materials = makeMaterialsLine(materialsFor);
            if (materials) {
                container.append(materials);
            }
        }

        renderExam();

        if (state.nowTimer === null) {
            state.nowTimer = setInterval(renderNow, 30 * 1000);
        }
    }

    function makeMaterialsLine(item) {
        if (!item || !window.cheeseForkMoodle || !window.cheeseForkMoodle.isConnected()) {
            return null;
        }
        var materials = window.cheeseForkMoodle.getMaterialsForLesson(item, 3);
        if (materials.length === 0) {
            return null;
        }
        var line = $('<div class="cf-mobile-materials"></div>');
        line.append('<i class="fas fa-paperclip"></i> ', $('<span></span>').text('חומר ב-Moodle: '));
        materials.forEach(function (material) {
            line.append($('<a target="_blank" rel="noopener"></a>').prop('href', material.url).text(material.filename || material.name));
        });
        var unread = window.cheeseForkMoodle.countUnread();
        if (unread > 0) {
            line.append(' ', $('<a href="#" class="badge badge-info cf-mobile-badge"></a>').text(unread + ' חדשים').click(function (event) {
                event.preventDefault();
                window.cheeseForkMoodle.showFeedDialog();
            }));
        }
        return line;
    }

    function dayOffsetText(offset, day) {
        if (offset === 1) {
            return 'מחר';
        }
        return 'יום ' + DAY_NAMES[day];
    }

    function daysBetween(from, to) {
        var a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
        var b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
        return Math.round((b - a) / (24 * 3600 * 1000));
    }

    // ---------------------------------------------------------------------
    // Exams
    // ---------------------------------------------------------------------

    function getExams() {
        var courseManager = api.courseManager;
        var exams = [];
        var now = new Date();

        api.getSelectedCourses().forEach(function (course) {
            var general = courseManager.getGeneralInfo(course);
            [['מועד א', 'מועד א\''], ['מועד ב', 'מועד ב\'']].forEach(function (moed) {
                if (!general[moed[0]]) {
                    return;
                }
                var parsed = courseManager.parseExamDateTime(general[moed[0]]);
                if (!parsed) {
                    return;
                }
                var dateParts = parsed.start.split('T');
                var ymd = dateParts[0].split('-');
                var hm = dateParts[1].split(':');
                var date = new Date(parseInt(ymd[0], 10), parseInt(ymd[1], 10) - 1, parseInt(ymd[2], 10),
                    parseInt(hm[0], 10), parseInt(hm[1], 10));
                exams.push({
                    course: course,
                    name: general['שם מקצוע'],
                    moed: moed[1],
                    date: date,
                    hasTime: !(date.getHours() === 0 && date.getMinutes() === 0),
                    daysLeft: daysBetween(now, date),
                    color: api.courseColorGenerator(course)
                });
            });
        });

        exams.sort(function (a, b) {
            return a.date - b.date;
        });

        return exams;
    }

    function examDaysText(exam) {
        if (exam.daysLeft < 0) {
            return 'עבר';
        }
        if (exam.daysLeft === 0) {
            return 'היום!';
        }
        if (exam.daysLeft === 1) {
            return 'מחר!';
        }
        return 'בעוד ' + exam.daysLeft + ' ימים';
    }

    function renderTask() {
        var container = $('#cf-mobile-card .cf-mobile-task').empty();
        if (!window.cheeseForkTasks || api.isViewingSharedSchedule()) {
            container.addClass('d-none');
            return;
        }

        var upcoming = window.cheeseForkTasks.getUpcoming();
        var overdue = window.cheeseForkTasks.getTasks('open').filter(function (task) {
            return task.dueDate && task.dueDate.getTime() < Date.now();
        });

        if (upcoming.length === 0 && overdue.length === 0) {
            container.addClass('d-none');
            return;
        }

        container.removeClass('d-none');
        if (overdue.length > 0) {
            container.append($('<span class="badge badge-danger cf-mobile-badge"></span>').text(overdue.length + ' באיחור'), ' ');
        }
        if (upcoming.length > 0) {
            var task = upcoming[0];
            var days = daysBetween(new Date(), task.dueDate);
            var when = days === 0 ? 'היום ' + moment(task.dueDate).format('HH:mm') :
                days === 1 ? 'מחר' : moment(task.dueDate).format('DD/MM') + ' · בעוד ' + days + ' ימים';
            container.append(
                '<i class="fas fa-tasks"></i> ',
                $('<span></span>').text('המטלה הבאה: '),
                $('<span class="cf-mobile-item-name"></span>').text(task.title),
                $('<span></span>').text(' · ' + when));
            var week = upcoming.filter(function (item) {
                return daysBetween(new Date(), item.dueDate) <= 7;
            }).length;
            if (week > 1) {
                container.append(' ', $('<span class="badge badge-light cf-mobile-badge"></span>').text(week + ' השבוע'));
            }
        }

        container.css('cursor', 'pointer').off('click').on('click', function () {
            if (window.cheeseForkMobile && window.cheeseForkMobile.openTasks) {
                window.cheeseForkMobile.openTasks();
            } else {
                window.cheeseForkTasks.showTasksDialog();
            }
        });
    }

    function renderExam() {
        renderTask();
        var container = $('#cf-mobile-card .cf-mobile-exam').empty();

        var upcoming = getExams().filter(function (exam) {
            return exam.daysLeft >= 0;
        });

        if (upcoming.length === 0) {
            container.addClass('d-none');
            return;
        }

        var exam = upcoming[0];
        container.removeClass('d-none');
        container.append(
            '<i class="fas fa-graduation-cap"></i> ',
            $('<span></span>').text('המבחן הבא: '),
            $('<span class="cf-mobile-item-name"></span>').text(exam.name),
            $('<span></span>').text(' (' + exam.moed + ') · ' + moment(exam.date).format(exam.hasTime ? 'DD/MM HH:mm' : 'DD/MM') + ' · '),
            $('<span class="font-weight-bold"></span>').text(examDaysText(exam)));
    }

    // ---------------------------------------------------------------------
    // Day agenda
    // ---------------------------------------------------------------------

    function buildAgenda() {
        var agenda = $('<div id="cf-mobile-agenda" class="col-md-10 d-none"></div>');
        agenda.append('<div class="cf-mobile-day-chips"></div>');
        agenda.append('<div class="cf-mobile-day-list"></div>');
        agenda.append('<div class="cf-mobile-exams-list"></div>');
        $('#course-calendar').before(agenda);
    }

    function setView(view, silent) {
        if (view !== 'day') {
            view = 'week';
        }
        if (view === 'day' && !isMobileMode()) {
            view = 'week';
        }

        state.view = view;
        if (!silent) {
            storageSet('cfMobileView', view);
        }

        var agenda = $('#cf-mobile-agenda');
        var calendar = $('#course-calendar');
        var button = $('#cf-mobile-view-button');

        if (view === 'day') {
            calendar.addClass('cf-mobile-hidden');
            agenda.removeClass('d-none');
            button.find('span').text('מערכת שבועית');
            button.find('i').removeClass('fa-calendar-alt').addClass('fa-th');
            renderAgenda();
        } else {
            agenda.addClass('d-none');
            calendar.removeClass('cf-mobile-hidden');
            button.find('span').text('תצוגת יום');
            button.find('i').removeClass('fa-th').addClass('fa-calendar-alt');
            try {
                calendar.fullCalendar('render');
            } catch (e) {
                // Not initialized yet.
            }
        }

        if (window.cheeseForkMobile && typeof window.cheeseForkMobile.onViewChanged === 'function') {
            window.cheeseForkMobile.onViewChanged(view);
        }
    }

    function shiftAgendaDay(delta) {
        if (state.agendaDay === null) {
            return;
        }
        var day = state.agendaDay + delta;
        if (day < 0 || day > 5) {
            return;
        }
        state.agendaDay = day;
        renderAgenda();
        hapticImpact();
    }

    function renderAgenda() {
        var agenda = $('#cf-mobile-agenda');
        if (agenda.hasClass('d-none')) {
            return;
        }

        var items = getScheduleItems();
        var now = new Date();

        if (state.agendaDay === null) {
            state.agendaDay = now.getDay() === 6 ? 0 : now.getDay();
        }

        var chips = agenda.find('.cf-mobile-day-chips').empty();
        for (var day = 0; day < 6; day++) {
            var hasItems = items.some(function (item) {
                return item.day === this;
            }, day);
            var chip = $('<button type="button" class="btn btn-sm cf-mobile-day-chip"></button>')
                .text(DAY_LETTERS[day])
                .toggleClass('btn-primary', day === state.agendaDay)
                .toggleClass('btn-outline-secondary', day !== state.agendaDay)
                .toggleClass('cf-mobile-day-chip-empty', !hasItems)
                .toggleClass('cf-mobile-day-chip-today', day === now.getDay())
                .attr('data-day', day)
                .click(function () {
                    state.agendaDay = parseInt($(this).attr('data-day'), 10);
                    renderAgenda();
                });
            chips.append(chip);
        }

        var list = agenda.find('.cf-mobile-day-list').empty();
        var dayItems = items.filter(function (item) {
            return item.day === state.agendaDay;
        });

        var title = 'יום ' + DAY_NAMES[state.agendaDay];
        if (state.agendaDay === now.getDay()) {
            title += ' (היום)';
        }
        list.append($('<h5 class="cf-mobile-day-title"></h5>').text(title));

        if (dayItems.length === 0) {
            list.append('<div class="cf-mobile-empty">אין שיעורים ביום זה 🎉</div>');
        }

        var nowMin = now.getHours() * 60 + now.getMinutes();
        var isToday = state.agendaDay === now.getDay();

        dayItems.forEach(function (item, i) {
            if (i > 0) {
                var gap = item.startMin - dayItems[i - 1].endMin;
                if (gap >= 30) {
                    list.append($('<div class="cf-mobile-gap"></div>').text('הפסקה של ' + formatDuration(gap)));
                }
            }

            var card = $('<div class="cf-mobile-lesson"></div>').css('border-right-color', item.color);
            if (window.cheeseForkMobile && typeof window.cheeseForkMobile.onLessonTap === 'function') {
                card.addClass('cf-mobile-lesson-tappable').click(function (event) {
                    if ($(event.target).closest('a').length > 0) {
                        return;
                    }
                    window.cheeseForkMobile.onLessonTap(item);
                });
            }
            if (isToday && item.startMin <= nowMin && nowMin < item.endMin) {
                card.addClass('cf-mobile-lesson-current');
            } else if (isToday && item.endMin <= nowMin) {
                card.addClass('cf-mobile-lesson-done');
            }

            card.append($('<div class="cf-mobile-lesson-time"></div>').text(
                formatMinutes(item.startMin) + ' - ' + formatMinutes(item.endMin)));
            card.append($('<div class="cf-mobile-lesson-name"></div>').text(item.name));

            var details = $('<div class="cf-mobile-lesson-details"></div>');
            if (!item.isCustom) {
                details.append($('<span></span>').text(item.type));
            }
            var location = makeLocationLink(item);
            if (location) {
                details.append(' · ', location);
            }
            if (item.staff) {
                details.append(' · ', $('<span></span>').text(item.staff));
            }
            card.append(details);

            list.append(card);
        });

        var examsList = agenda.find('.cf-mobile-exams-list').empty();
        var exams = getExams().filter(function (exam) {
            return exam.daysLeft >= -1;
        });
        if (exams.length > 0) {
            examsList.append('<h5 class="cf-mobile-day-title"><i class="fas fa-graduation-cap"></i> מבחנים קרובים</h5>');
            exams.forEach(function (exam) {
                var row = $('<div class="cf-mobile-exam-row"></div>');
                row.append($('<span class="cf-mobile-item-color"></span>').css('background-color', exam.color));
                row.append($('<span class="cf-mobile-exam-date"></span>').text(
                    moment(exam.date).format(exam.hasTime ? 'DD/MM HH:mm' : 'DD/MM')));
                row.append(' ', $('<span class="cf-mobile-item-name"></span>').text(exam.name));
                row.append(' ', $('<span class="cf-mobile-small"></span>').text(exam.moed));
                row.append(' ', $('<span class="badge cf-mobile-badge"></span>')
                    .addClass(exam.daysLeft <= 3 ? 'badge-danger' : exam.daysLeft <= 10 ? 'badge-warning' : 'badge-light')
                    .text(examDaysText(exam)));
                examsList.append(row);
            });
        }
    }

    // ---------------------------------------------------------------------
    // Days off (holidays) of the semester
    // ---------------------------------------------------------------------

    function loadDaysOff() {
        var key = 'cfMobileDaysOff_' + api.currentSemester;
        var cached = storageGet(key);
        if (cached) {
            try {
                var parsed = JSON.parse(cached);
                state.daysOff = parsed.daysOff;
                if (Date.now() - parsed.time < 24 * 3600 * 1000) {
                    return;
                }
            } catch (e) {
                // Ignore.
            }
        }

        var url = 'https://michael-maltsev.github.io/technion-calendar-events/' + api.currentSemester + '.json';
        $.getJSON(url).done(function (data) {
            state.daysOff = data.daysOff || [];
            storageSet(key, JSON.stringify({time: Date.now(), daysOff: state.daysOff}));
            renderNow();
        });
    }

    // ---------------------------------------------------------------------
    // Sharing
    // ---------------------------------------------------------------------

    function shareSchedule() {
        var url = api.getShareUrl();
        if (!url) {
            BootstrapDialog.show({
                title: 'שיתוף מערכת',
                message: 'יש לבצע כניסה על מנת לשתף את המערכת. לאחר הכניסה, כל מי שיקבל את הקישור יוכל לצפות במערכת שלכם ולייבא אותה.',
                size: BootstrapDialog.SIZE_SMALL
            });
            return;
        }

        var title = 'המערכת שלי ב-CheeseFork - ' + api.semesterFriendlyName(api.currentSemester);
        shareUrl(title, url, function () {
            api.copyToClipboard(url, function () {
                showToast('הקישור הועתק');
            }, function () {
                BootstrapDialog.show({
                    title: 'שיתוף מערכת',
                    message: $('<div>הקישור לשיתוף המערכת: </div>').append($('<a target="_blank" rel="noopener"></a>').prop('href', url).text(url))
                });
            });
        });
    }

    function shareUrl(title, url, fallback) {
        var share = platform.plugin('Share');
        if (share) {
            share.share({title: title, text: title, url: url, dialogTitle: title}).catch(function () {});
            return;
        }
        if (navigator.share) {
            navigator.share({title: title, url: url}).catch(function () {});
            return;
        }
        fallback();
    }

    // Shares a text file through the native share sheet (used for the
    // iCalendar export, since web views can't download blobs).
    platform.saveTextFile = platform.isNative ? function (name, text) {
        var filesystem = platform.plugin('Filesystem');
        var share = platform.plugin('Share');
        if (!filesystem || !share) {
            alert('השיתוף לא זמין');
            return;
        }
        filesystem.writeFile({
            path: name,
            data: text,
            directory: 'CACHE',
            encoding: 'utf8'
        }).then(function (result) {
            return share.share({title: name, files: [result.uri], dialogTitle: 'ייצוא המערכת'});
        }).catch(function (error) {
            if (!/cancel/i.test(String(error && error.message))) {
                alert('השיתוף נכשל: ' + (error && error.message));
            }
        });
    } : null;

    // ---------------------------------------------------------------------
    // Import a schedule from a share link
    // ---------------------------------------------------------------------

    function parseShareLink(text) {
        text = (text || '').trim();
        if (!text) {
            return null;
        }

        var userId = null;
        var semester = null;

        if (/^https?:\/\//i.test(text)) {
            userId = getParameterByName('uid', text);
            semester = getParameterByName('semester', text);
        } else if (/^[A-Za-z0-9_-]{10,}$/.test(text)) {
            userId = text;
        }

        if (!userId) {
            return null;
        }

        return {userId: userId, semester: semester};
    }

    function describeSession(session) {
        var courseManager = api.courseManager;
        var courses = (session[api.currentSemester + '_courses'] || []).filter(function (course) {
            return courseManager.doesExist(course);
        });
        var customEvents = Object.keys(session[api.currentSemester + '_custom_events'] || {}).length;

        var list = $('<ul class="cf-mobile-course-list"></ul>');
        courses.forEach(function (course) {
            list.append($('<li></li>').text(courseManager.getTitle(course)));
        });

        var summary = $('<div></div>');
        if (courses.length === 0) {
            summary.append('<div>המערכת ריקה עבור סמסטר זה.</div>');
        } else {
            summary.append($('<div></div>').text(courses.length + ' מקצועות' + (customEvents > 0 ? ', ' + customEvents + ' אירועים מותאמים אישית' : '') + ':'));
            summary.append(list);
        }
        return {courses: courses, html: summary};
    }

    function showImportDialog(presetUserId) {
        var input = $('<input type="text" class="form-control" dir="ltr" placeholder="https://cheesefork.cf/?semester=...&uid=...">');
        var result = $('<div class="cf-mobile-import-result mt-3"></div>');
        var loadedSession = null;

        var message = $('<div></div>').append(
            '<p>הדביקו קישור שיתוף של מערכת (שלכם מהאתר, או של חבר/ה) כדי להעתיק אותה למכשיר זה. ' +
            'המערכת הנוכחית תוחלף, וניתן לבטל בעזרת כפתור "בטל שינויים".</p>',
            input, result);

        var dialog = BootstrapDialog.show({
            title: 'ייבוא מערכת מקישור שיתוף',
            message: message,
            onshown: function () {
                if (presetUserId) {
                    input.val(presetUserId);
                    loadLink();
                } else {
                    input.focus();
                }
            },
            buttons: [{
                id: 'import-load',
                label: 'טעינה',
                action: loadLink
            }, {
                id: 'import-apply',
                label: 'ייבוא',
                cssClass: 'btn-primary',
                action: function () {
                    if (!loadedSession) {
                        return;
                    }
                    trackEvent('mobile-import-apply');
                    api.importSession(loadedSession);
                    dialog.close();
                    showToast('המערכת יובאה בהצלחה');
                    hapticImpact();
                }
            }, {
                label: 'סגור',
                action: function () {
                    dialog.close();
                }
            }],
            onshow: function (d) {
                d.getButton('import-apply').disable();
            }
        });

        input.on('keydown', function (event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                loadLink();
            }
        });

        function loadLink() {
            var link = parseShareLink(input.val());
            if (!link) {
                result.html('<div class="text-danger">הקישור לא זוהה. יש להדביק קישור שיתוף מלא מ-CheeseFork.</div>');
                return;
            }

            if (link.semester && link.semester !== api.currentSemester) {
                if (!api.availableSemesters[link.semester]) {
                    result.html('<div class="text-danger">הסמסטר בקישור לא קיים.</div>');
                    return;
                }
                result.html($('<div></div>').text(
                    'הקישור שייך לסמסטר ' + api.semesterFriendlyName(link.semester) + '. מעבר לסמסטר...'));
                location.href = location.pathname + '?semester=' + encodeURIComponent(link.semester) + '&cfimport=' + encodeURIComponent(link.userId);
                return;
            }

            result.html('<div class="text-muted">טוען...</div>');
            dialog.getButton('import-apply').disable();
            loadedSession = null;

            api.loadSharedSession(link.userId, function (error, session, displayName) {
                if (error) {
                    result.html('<div class="text-danger">טעינת המערכת נכשלה. בדקו את הקישור ואת החיבור לאינטרנט.</div>');
                    return;
                }

                var description = describeSession(session);
                result.empty();
                if (displayName) {
                    result.append($('<div class="font-weight-bold"></div>').text('המערכת של ' + displayName));
                }
                result.append(description.html);

                if (description.courses.length > 0) {
                    loadedSession = session;
                    dialog.getButton('import-apply').enable();
                }
            });
        }
    }

    // ---------------------------------------------------------------------
    // Free time together ("when are we both free?")
    // ---------------------------------------------------------------------

    function stringHexEncode(str) {
        var result = '';
        for (var i = 0; i < str.length; i++) {
            var hex = str.charCodeAt(i).toString(16);
            result += ('000' + hex).slice(-4);
        }
        return result;
    }

    // Same as the lesson type key used by the calendar when saving a session.
    function lessonTypeKey(course, lesson) {
        if (/^(394[89]\d\d|03940[89]\d\d)$/.test(course)) {
            return 'sport';
        }
        return stringHexEncode(lesson['סוג']);
    }

    // Converts a saved session to busy intervals ({day, startMin, endMin}).
    function sessionToIntervals(session) {
        var courseManager = api.courseManager;
        var semester = api.currentSemester;
        var intervals = [];

        (session[semester + '_courses'] || []).forEach(function (course) {
            if (!courseManager.doesExist(course)) {
                return;
            }
            var selected = session[semester + '_' + course] || {};
            var lessonsAdded = {};
            courseManager.getSchedule(course).forEach(function (lesson) {
                if (lessonsAdded[lesson['מס.']] && lessonsAdded[lesson['מס.']] !== lesson['קבוצה']) {
                    return;
                }
                lessonsAdded[lesson['מס.']] = lesson['קבוצה'];

                if (selected[lessonTypeKey(course, lesson)] !== lesson['מס.']) {
                    return;
                }

                var time = courseManager.parseLessonTime(lesson['שעה']);
                var dayIndex = DAY_NAMES.indexOf(lesson['יום']);
                if (dayIndex === -1) {
                    dayIndex = DAY_LETTERS.indexOf(lesson['יום']);
                }
                if (!time || dayIndex === -1) {
                    return;
                }
                var startParts = time.start.split(':');
                var endParts = time.end.split(':');
                var endMin = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);
                intervals.push({
                    day: dayIndex,
                    startMin: parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10),
                    endMin: endMin === 0 ? 24 * 60 : endMin
                });
            });
        });

        var customEvents = session[semester + '_custom_events'] || {};
        Object.keys(customEvents).forEach(function (id) {
            var event = customEvents[id];
            var start = moment(event.start);
            var end = moment(event.end);
            if (!start.isValid() || !end.isValid()) {
                return;
            }
            intervals.push({
                day: start.day(),
                startMin: start.hours() * 60 + start.minutes(),
                endMin: end.day() !== start.day() ? 24 * 60 : end.hours() * 60 + end.minutes()
            });
        });

        return intervals;
    }

    function mergeIntervals(intervals) {
        var sorted = intervals.slice().sort(function (a, b) {
            return a.startMin - b.startMin;
        });
        var merged = [];
        sorted.forEach(function (interval) {
            var last = merged[merged.length - 1];
            if (last && interval.startMin <= last.endMin) {
                last.endMin = Math.max(last.endMin, interval.endMin);
            } else {
                merged.push({startMin: interval.startMin, endMin: interval.endMin});
            }
        });
        return merged;
    }

    function computeFreeTime(mine, theirs, minGap) {
        var result = [];
        for (var day = 0; day < 6; day++) {
            var busy = mergeIntervals(mine.concat(theirs).filter(function (interval) {
                return interval.day === day;
            }));
            var windowStart = 8 * 60 + 30;
            var windowEnd = 18 * 60 + 30;
            busy.forEach(function (interval) {
                windowStart = Math.min(windowStart, interval.startMin);
                windowEnd = Math.max(windowEnd, interval.endMin);
            });

            var free = [];
            var cursor = windowStart;
            busy.forEach(function (interval) {
                if (interval.startMin - cursor >= minGap) {
                    free.push({startMin: cursor, endMin: interval.startMin});
                }
                cursor = Math.max(cursor, interval.endMin);
            });
            if (windowEnd - cursor >= minGap) {
                free.push({startMin: cursor, endMin: windowEnd});
            }

            result.push({day: day, busy: busy, free: free, allDay: busy.length === 0});
        }
        return result;
    }

    function showFreeTimeDialog() {
        var input = $('<input type="text" class="form-control" dir="ltr" placeholder="קישור שיתוף של חבר/ה">');
        var result = $('<div class="mt-3"></div>');

        var message = $('<div></div>').append(
            '<p>הדביקו קישור שיתוף של חבר/ה כדי לראות מתי שניכם פנויים במהלך השבוע.</p>',
            input, result);

        var dialog = BootstrapDialog.show({
            title: 'מתי שנינו פנויים?',
            message: message,
            onshown: function () {
                input.focus();
            },
            buttons: [{
                label: 'חישוב',
                cssClass: 'btn-primary',
                action: compute
            }, {
                label: 'סגור',
                action: function () {
                    dialog.close();
                }
            }]
        });

        input.on('keydown', function (event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                compute();
            }
        });

        function compute() {
            var link = parseShareLink(input.val());
            if (!link) {
                result.html('<div class="text-danger">הקישור לא זוהה. יש להדביק קישור שיתוף מלא מ-CheeseFork.</div>');
                return;
            }
            if (link.semester && link.semester !== api.currentSemester) {
                result.html($('<div class="text-danger"></div>').text(
                    'הקישור שייך לסמסטר ' + api.semesterFriendlyName(link.semester) + ', אבל מוצג כרגע סמסטר ' +
                    api.semesterFriendlyName(api.currentSemester) + '.'));
                return;
            }

            result.html('<div class="text-muted">טוען...</div>');

            api.loadSharedSession(link.userId, function (error, session, displayName) {
                if (error) {
                    result.html('<div class="text-danger">טעינת המערכת נכשלה. בדקו את הקישור ואת החיבור לאינטרנט.</div>');
                    return;
                }

                trackEvent('mobile-free-time-compute');

                var mine = getScheduleItems();
                var theirs = sessionToIntervals(session);
                var days = computeFreeTime(mine, theirs, 30);

                result.empty();
                result.append($('<div class="font-weight-bold mb-2"></div>').text(
                    'זמנים פנויים משותפים' + (displayName ? ' עם ' + displayName : '') + ':'));

                var table = $('<table class="table table-sm cf-mobile-free-table"></table>');
                days.forEach(function (day) {
                    var row = $('<tr></tr>');
                    row.append($('<th scope="row"></th>').text(DAY_NAMES[day.day]));
                    var cell = $('<td></td>');
                    if (day.allDay) {
                        cell.append('<span class="badge badge-success cf-mobile-badge">פנויים כל היום</span>');
                    } else if (day.free.length === 0) {
                        cell.append('<span class="text-muted">אין זמן פנוי משותף</span>');
                    } else {
                        day.free.forEach(function (slot) {
                            var length = slot.endMin - slot.startMin;
                            cell.append($('<span class="badge cf-mobile-badge cf-mobile-free-slot"></span>')
                                .addClass(length >= 120 ? 'badge-success' : length >= 60 ? 'badge-info' : 'badge-light')
                                .text(formatMinutes(slot.startMin) + '-' + formatMinutes(slot.endMin)), ' ');
                        });
                    }
                    row.append(cell);
                    table.append(row);
                });
                result.append(table);
                result.append('<div class="cf-mobile-small text-muted">ירוק: שעתיים ומעלה, כחול: שעה ומעלה. מחושב לפי השיעורים שנבחרו בשתי המערכות.</div>');
            });
        }
    }

    // ---------------------------------------------------------------------
    // Reminders (native app only, local notifications)
    // ---------------------------------------------------------------------

    function getReminderSettings() {
        var defaults = {enabled: false, minutesBefore: 15, exams: true, tasks: true};
        try {
            return $.extend(defaults, JSON.parse(storageGet('cfMobileReminders') || '{}'));
        } catch (e) {
            return defaults;
        }
    }

    function setReminderSettings(settings) {
        storageSet('cfMobileReminders', JSON.stringify(settings));
    }

    function showRemindersDialog() {
        var settings = getReminderSettings();

        var form = $('<form></form>');
        form.append(
            '<div class="form-check mb-3">' +
                '<input class="form-check-input" type="checkbox" id="cf-reminders-enabled">' +
                '<label class="form-check-label" for="cf-reminders-enabled">תזכורת לפני כל שיעור</label>' +
            '</div>' +
            '<div class="form-group">' +
                '<label for="cf-reminders-minutes">כמה זמן לפני השיעור</label>' +
                '<select class="form-control" id="cf-reminders-minutes">' +
                    '<option value="5">5 דקות</option>' +
                    '<option value="10">10 דקות</option>' +
                    '<option value="15">15 דקות</option>' +
                    '<option value="30">30 דקות</option>' +
                    '<option value="60">שעה</option>' +
                '</select>' +
            '</div>' +
            '<div class="form-check mb-3">' +
                '<input class="form-check-input" type="checkbox" id="cf-reminders-exams">' +
                '<label class="form-check-label" for="cf-reminders-exams">תזכורת יום לפני כל מבחן ובבוקר המבחן</label>' +
            '</div>' +
            '<div class="form-check mb-3">' +
                '<input class="form-check-input" type="checkbox" id="cf-reminders-tasks">' +
                '<label class="form-check-label" for="cf-reminders-tasks">תזכורת ערב לפני ובבוקר של כל מטלה (Moodle וידניות)</label>' +
            '</div>' +
            '<div class="cf-mobile-small text-muted">' +
                'התזכורות מחושבות מהמערכת שבניתם ומתעדכנות אוטומטית בכל שינוי. ' +
                'תזכורות לשיעורים פעילות רק במהלך הסמסטר. ' +
                'אם התזכורות לא מגיעות, בדקו שהאפליקציה מורשית לשלוח התראות בהגדרות המכשיר.' +
            '</div>');

        form.find('#cf-reminders-enabled').prop('checked', settings.enabled);
        form.find('#cf-reminders-minutes').val(String(settings.minutesBefore));
        form.find('#cf-reminders-exams').prop('checked', settings.exams);
        form.find('#cf-reminders-tasks').prop('checked', settings.tasks);

        // Android 12+: without the "alarms & reminders" permission the system
        // may deliver the reminders a few minutes late.
        var notifications = platform.plugin('LocalNotifications');
        if (notifications && typeof notifications.checkExactNotificationSetting === 'function') {
            notifications.checkExactNotificationSetting().then(function (result) {
                if (result.exact_alarm === 'granted') {
                    return;
                }
                var note = $('<div class="alert alert-warning mt-3 cf-mobile-small"></div>').text(
                    'כדי שהתזכורות יגיעו בזמן המדויק, אפשרו לאפליקציה "התראות ותזכורות" בהגדרות המכשיר. ');
                note.append($('<a href="#">פתיחת ההגדרה</a>').click(function (event) {
                    event.preventDefault();
                    notifications.changeExactNotificationSetting().catch(function () {});
                }));
                form.append(note);
            }).catch(function () {});
        }

        var dialog = BootstrapDialog.show({
            title: 'תזכורות',
            message: form,
            buttons: [{
                label: 'שמירה',
                cssClass: 'btn-primary',
                action: function () {
                    var newSettings = {
                        enabled: form.find('#cf-reminders-enabled').prop('checked'),
                        minutesBefore: parseInt(form.find('#cf-reminders-minutes').val(), 10),
                        exams: form.find('#cf-reminders-exams').prop('checked'),
                        tasks: form.find('#cf-reminders-tasks').prop('checked')
                    };
                    setReminderSettings(newSettings);
                    dialog.close();
                    trackEvent('mobile-reminders-save');
                    syncReminders(true);
                }
            }, {
                label: 'סגור',
                action: function () {
                    dialog.close();
                }
            }]
        });
    }

    function scheduleRemindersSync() {
        if (!platform.isNative) {
            return;
        }
        if (state.remindersSyncTimer !== null) {
            clearTimeout(state.remindersSyncTimer);
        }
        state.remindersSyncTimer = setTimeout(function () {
            state.remindersSyncTimer = null;
            syncReminders(false);
        }, 3000);
    }

    function buildLessonNotifications(settings) {
        var now = new Date();
        var semester = api.availableSemesters[api.currentSemester];
        if (semester) {
            var start = parseLocalDate(semester.start);
            start.setDate(start.getDate() - 1);
            var end = parseLocalDate(semester.end);
            end.setDate(end.getDate() + 1);
            if (now < start || now >= end) {
                return [];
            }
        }

        return getScheduleItems().map(function (item, i) {
            var minutes = Math.max(0, item.startMin - settings.minutesBefore);
            var body = (item.isCustom ? '' : item.type + ' · ') +
                formatMinutes(item.startMin) + '-' + formatMinutes(item.endMin);
            var location = formatLocation(item);
            if (location) {
                body += ' · ' + location;
            }
            return {
                id: LESSON_REMINDER_ID_BASE + i,
                title: 'בעוד ' + settings.minutesBefore + ' דקות: ' + item.name,
                body: body,
                schedule: {
                    on: {
                        weekday: item.day + 1,
                        hour: Math.floor(minutes / 60),
                        minute: minutes % 60
                    },
                    allowWhileIdle: true
                }
            };
        });
    }

    function buildExamNotifications() {
        var notifications = [];
        var now = Date.now();

        getExams().forEach(function (exam, i) {
            var dateText = moment(exam.date).format(exam.hasTime ? 'DD/MM בשעה HH:mm' : 'DD/MM');

            var dayBefore = new Date(exam.date.getFullYear(), exam.date.getMonth(), exam.date.getDate() - 1, 18, 0);
            if (dayBefore.getTime() > now) {
                notifications.push({
                    id: EXAM_REMINDER_ID_BASE + i * 2,
                    title: 'מחר מבחן: ' + exam.name,
                    body: exam.moed + ' · ' + dateText + '. בהצלחה!',
                    schedule: {at: dayBefore, allowWhileIdle: true}
                });
            }

            var morning = new Date(exam.date.getFullYear(), exam.date.getMonth(), exam.date.getDate(), 7, 30);
            if (exam.hasTime) {
                morning = new Date(exam.date.getTime() - 2 * 3600 * 1000);
            }
            if (morning.getTime() > now) {
                notifications.push({
                    id: EXAM_REMINDER_ID_BASE + i * 2 + 1,
                    title: 'היום מבחן: ' + exam.name,
                    body: exam.moed + ' · ' + dateText,
                    schedule: {at: morning, allowWhileIdle: true}
                });
            }
        });

        return notifications;
    }

    function syncReminders(interactive) {
        var notifications = platform.plugin('LocalNotifications');
        if (!notifications || api.isViewingSharedSchedule()) {
            return;
        }

        var settings = getReminderSettings();
        var wanted = [];
        if (settings.enabled) {
            wanted = wanted.concat(buildLessonNotifications(settings));
        }
        if (settings.exams) {
            wanted = wanted.concat(buildExamNotifications());
        }
        if (settings.tasks && window.cheeseForkTasks) {
            wanted = wanted.concat(window.cheeseForkTasks.buildNotifications(TASK_REMINDER_ID_BASE));
        }

        // iOS allows up to 64 pending notifications per app.
        wanted = wanted.slice(0, 60);

        var ensurePermission = wanted.length > 0
            ? notifications.requestPermissions().then(function (result) {
                return result.display === 'granted';
            })
            : Promise.resolve(true);

        ensurePermission.then(function (granted) {
            if (!granted) {
                if (interactive) {
                    alert('האפליקציה לא מורשית לשלוח התראות. ניתן לאשר זאת בהגדרות המכשיר.');
                }
                return null;
            }

            return notifications.getPending().then(function (pending) {
                var ours = (pending.notifications || []).filter(function (notification) {
                    return notification.id >= LESSON_REMINDER_ID_BASE && notification.id < REMINDER_ID_END;
                }).map(function (notification) {
                    return {id: notification.id};
                });
                if (ours.length === 0) {
                    return null;
                }
                return notifications.cancel({notifications: ours});
            }).then(function () {
                if (wanted.length === 0) {
                    return null;
                }
                return notifications.schedule({notifications: wanted});
            }).then(function () {
                if (interactive) {
                    if (wanted.length > 0) {
                        showToast('נקבעו ' + wanted.length + ' תזכורות');
                    } else if (settings.enabled) {
                        showToast('התזכורות יופעלו עם תחילת הסמסטר');
                    } else {
                        showToast('התזכורות בוטלו');
                    }
                }
            });
        }).catch(function (error) {
            if (interactive) {
                alert('קביעת התזכורות נכשלה: ' + (error && error.message));
            }
        });
    }

    // ---------------------------------------------------------------------
    // Android home screen widget ("today's lessons")
    // ---------------------------------------------------------------------

    function scheduleDayWidgetUpdate() {
        if (!platform.isNative || platform.os !== 'android') {
            return;
        }
        if (state.widgetTimer) {
            clearTimeout(state.widgetTimer);
        }
        state.widgetTimer = setTimeout(updateDayWidget, 1500);
    }

    function updateDayWidget() {
        var widget = platform.plugin('DayWidget');
        if (!widget) {
            return;
        }

        var semester = api.availableSemesters[api.currentSemester] || {};
        var items = api.isViewingSharedSchedule() ? [] : getScheduleItems().map(function (item) {
            return {
                day: item.day,
                startMin: item.startMin,
                endMin: item.endMin,
                name: item.name,
                type: item.isCustom ? '' : item.type,
                location: formatLocation(item),
                staff: item.staff,
                color: item.color
            };
        });

        var tasks = [];
        if (window.cheeseForkTasks && !api.isViewingSharedSchedule()) {
            tasks = window.cheeseForkTasks.getUpcoming().slice(0, 3).map(function (task) {
                return {
                    title: task.title,
                    due: moment(task.dueDate).format('DD/MM HH:mm'),
                    daysLeft: daysBetween(new Date(), task.dueDate)
                };
            });
        }

        widget.update({
            semesterStart: semester.start || '',
            semesterEnd: semester.end || '',
            daysOff: state.daysOff || [],
            items: items,
            tasks: tasks
        }).catch(function () {});
    }

    // ---------------------------------------------------------------------
    // Sign-in notice on other domains
    // ---------------------------------------------------------------------

    // The CheeseFork Firebase API key only accepts requests from
    // cheesefork.cf, so on any other host (a fork on GitHub Pages, a dev
    // server) signing in and syncing can't work. Explain it in the login
    // dialog instead of showing a cryptic Firebase error.
    function loginNoticeInit() {
        if (platform.isNative || location.hostname === 'cheesefork.cf') {
            return;
        }

        $('#top-navbar-login').on('click', function () {
            setTimeout(function () {
                var container = $('#firebaseui-auth-container');
                if (container.find('.cf-mobile-login-notice').length > 0) {
                    return;
                }
                container.prepend($('<div class="alert alert-warning cf-mobile-small cf-mobile-login-notice"></div>').text(
                    'בכתובת זו (' + location.hostname + ') לא ניתן להתחבר לחשבון: שרת CheeseFork מקבל בקשות רק מ-cheesefork.cf. ' +
                    'המערכת נשמרת במכשיר זה גם ללא חיבור. להתחברות ולסנכרון השתמשו באפליקציה או באתר cheesefork.cf.'));
            }, 300);
        });
    }

    // ---------------------------------------------------------------------
    // Install (PWA)
    // ---------------------------------------------------------------------

    function installPromptInit() {
        if (platform.isNative || platform.isStandalone) {
            return;
        }

        window.addEventListener('beforeinstallprompt', function (event) {
            event.preventDefault();
            state.installPrompt = event;
            $('#cf-mobile-install-button').removeClass('d-none');
        });

        window.addEventListener('appinstalled', function () {
            state.installPrompt = null;
            $('#cf-mobile-install-button').addClass('d-none');
            showToast('CheeseFork הותקן בהצלחה');
        });

        // iOS has no install prompt, show how to add to the home screen.
        var isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (isIos && !storageGet('cfMobileIosInstallHintDismissed')) {
            $('#cf-mobile-install-button').removeClass('d-none');
        }
    }

    function installApp() {
        if (state.installPrompt) {
            state.installPrompt.prompt();
            state.installPrompt.userChoice.then(function () {
                state.installPrompt = null;
                $('#cf-mobile-install-button').addClass('d-none');
            });
            return;
        }

        BootstrapDialog.show({
            title: 'הוספת CheeseFork למסך הבית',
            message: '<ol class="pr-3">' +
                    '<li>פתחו את האתר ב-Safari.</li>' +
                    '<li>לחצו על כפתור השיתוף <i class="fas fa-share"></i> (בסרגל הכלים).</li>' +
                    '<li>בחרו "הוסף למסך הבית" ואשרו.</li>' +
                '</ol>' +
                '<div>לאחר מכן CheeseFork ייפתח כאפליקציה, גם ללא חיבור לאינטרנט.</div>',
            buttons: [{
                label: 'אל תציג שוב',
                action: function (dialog) {
                    storageSet('cfMobileIosInstallHintDismissed', '1');
                    $('#cf-mobile-install-button').addClass('d-none');
                    dialog.close();
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

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) {
            return;
        }
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            return;
        }

        navigator.serviceWorker.register('sw.js').then(function (registration) {
            registration.addEventListener('updatefound', function () {
                var worker = registration.installing;
                if (!worker) {
                    return;
                }
                worker.addEventListener('statechange', function () {
                    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                        showToast('גרסה חדשה של CheeseFork זמינה', 'רענון', function () {
                            location.reload();
                        });
                    }
                });
            });
        }).catch(function () {
            // Offline support is optional.
        });
    }

    // ---------------------------------------------------------------------
    // Native app integration (Capacitor)
    // ---------------------------------------------------------------------

    function nativeInit() {
        if (!platform.isNative) {
            return;
        }

        $('body').addClass('cf-native cf-native-' + platform.os);

        var splash = platform.plugin('SplashScreen');
        if (splash) {
            splash.hide().catch(function () {});
        }

        updateStatusBar();
        var toggle = document.querySelector('dark-mode-toggle');
        if (toggle) {
            toggle.addEventListener('colorschemechange', updateStatusBar);
        }
        try {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateStatusBar);
        } catch (e) {
            // Ignore.
        }

        var app = platform.plugin('App');
        if (app) {
            app.addListener('backButton', onBackButton);
            app.addListener('appStateChange', function (appState) {
                if (appState.isActive) {
                    renderNow();
                    renderStatus();
                    scheduleRemindersSync();
                }
            });
        }

        // Keep the reminders in sync with the schedule on every launch.
        scheduleRemindersSync();
    }

    function isDarkMode() {
        var toggle = document.querySelector('dark-mode-toggle');
        if (toggle && toggle.mode) {
            return toggle.mode === 'dark';
        }
        try {
            var saved = localStorage.getItem('dark-mode-toggle');
            if (saved === 'dark' || saved === 'light') {
                return saved === 'dark';
            }
        } catch (e) {
            // Ignore.
        }
        try {
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch (e) {
            return false;
        }
    }

    function updateStatusBar() {
        var statusBar = platform.plugin('StatusBar');
        if (!statusBar) {
            return;
        }
        var dark = isDarkMode();
        statusBar.setStyle({style: dark ? 'DARK' : 'LIGHT'}).catch(function () {});
        if (platform.os === 'android') {
            statusBar.setBackgroundColor({color: dark ? '#212529' : '#f8f9fa'}).catch(function () {});
        }
    }

    function onBackButton() {
        var app = platform.plugin('App');

        for (var i = state.backHandlers.length - 1; i >= 0; i--) {
            if (state.backHandlers[i]()) {
                return;
            }
        }

        var openModal = $('.modal.show').last();
        if (openModal.length > 0) {
            openModal.modal('hide');
            return;
        }

        if ($('#top-navbar-supported-content').hasClass('show')) {
            $('#top-navbar-supported-content').collapse('hide');
            return;
        }

        var now = Date.now();
        if (now - state.backButtonPressedAt < 2000) {
            if (app) {
                app.exitApp();
            }
            return;
        }
        state.backButtonPressedAt = now;
        showToast('לחצו שוב ליציאה');
    }

    function hapticImpact() {
        var haptics = platform.plugin('Haptics');
        if (haptics) {
            haptics.impact({style: 'LIGHT'}).catch(function () {});
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function showToast(text, actionText, onAction) {
        var toast = $('<div class="cf-mobile-toast"></div>').text(text);
        if (actionText) {
            toast.append(' ', $('<button type="button" class="btn btn-sm btn-primary"></button>').text(actionText).click(function () {
                onAction();
                toast.remove();
            }));
        }
        $('body').append(toast);
        setTimeout(function () {
            toast.addClass('cf-mobile-toast-visible');
        }, 10);
        setTimeout(function () {
            toast.removeClass('cf-mobile-toast-visible');
            setTimeout(function () {
                toast.remove();
            }, 300);
        }, actionText ? 10000 : 3000);
    }

    function trackEvent(name) {
        if (typeof gtag === 'function') {
            gtag('event', name);
        }
    }

    function debounce(func, wait) {
        var timer = null;
        return function () {
            if (timer !== null) {
                clearTimeout(timer);
            }
            timer = setTimeout(func, wait);
        };
    }

    function storageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // Ignore.
        }
    }

    // https://stackoverflow.com/a/901144
    function getParameterByName(name, url) {
        if (!url) url = window.location.href;
        name = name.replace(/[[\]]/g, "\\$&");
        var regex = new RegExp("[?&]" + name + "(=([^&#]*)|&|#|$)"),
            results = regex.exec(url);
        if (!results) return null;
        if (!results[2]) return '';
        return decodeURIComponent(results[2].replace(/\+/g, " "));
    }
})();
