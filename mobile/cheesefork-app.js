'use strict';

/* global BootstrapDialog, gtag */

// The app shell: bottom navigation with tabs (schedule / today / grades /
// more), bottom sheets, and swipe between days. Active in the native app,
// or in a browser with ?appui=1. Builds on the mobile layer
// (cheesefork-mobile.js) through window.cheeseForkMobile.

(function () {
    var platform = window.cheeseForkPlatform;
    if (!platform || !platform.appUi) {
        return;
    }

    var mobile = null;
    var api = null;

    var TABS = [
        {id: 'week', icon: 'fa-th', label: 'מערכת'},
        {id: 'day', icon: 'fa-calendar-day', label: 'היום'},
        {id: 'tasks', icon: 'fa-tasks', label: 'מטלות'},
        {id: 'grades', icon: 'fa-graduation-cap', label: 'ציונים'},
        {id: 'more', icon: 'fa-ellipsis-h', label: 'עוד'}
    ];

    var state = {
        tab: 'week',
        sheet: null,
        gradesRendered: false
    };

    $(function () {
        $('body').addClass('cf-app');
        if (window.cheeseForkMobile) {
            onReady();
        } else {
            $(document).one('cheesefork:mobile-ready', onReady);
        }
    });

    function onReady() {
        mobile = window.cheeseForkMobile;
        api = window.cheeseFork;

        if ($('#right-content-bar').length === 0) {
            return;
        }

        buildHeader();
        buildTabs();
        buildPanels();
        buildAssistantButton();
        initSwipe();

        mobile.onLessonTap = showCourseSheet;
        mobile.openTasks = function () {
            selectTab('tasks');
        };
        mobile.onViewChanged = function (view) {
            if ((view === 'day' || view === 'week') && state.tab !== view && (state.tab === 'day' || state.tab === 'week')) {
                selectTab(view, true);
            }
        };
        mobile.registerBackHandler(function () {
            if (state.sheet) {
                closeSheet();
                return true;
            }
            if (state.tab !== 'week') {
                selectTab('week');
                return true;
            }
            return false;
        });

        $(document).on('cheesefork:schedule-changed', function () {
            if (state.tab === 'grades') {
                renderGradesPanel();
            }
        });
        $(document).on('cheesefork:tasks-changed', updateTasksBadge);
        updateTasksBadge();

        selectTab(mobile.getView() === 'day' ? 'day' : 'week', true);
    }

    // ---------------------------------------------------------------------
    // Header
    // ---------------------------------------------------------------------

    function buildHeader() {
        var semester = api.semesterFriendlyName(api.currentSemester);
        var header = $('<div class="cf-app-header-info"></div>');
        header.append($('<span class="cf-app-header-semester"></span>').text(semester));
        $('#top-navbar').append(header);
    }

    // ---------------------------------------------------------------------
    // Bottom navigation and tabs
    // ---------------------------------------------------------------------

    function buildTabs() {
        var nav = $('<nav id="cf-app-nav" class="cf-app-nav"></nav>');
        TABS.forEach(function (tab) {
            if ((tab.id === 'grades' || tab.id === 'tasks') && api.isViewingSharedSchedule()) {
                return;
            }
            var button = $('<button type="button" class="cf-app-nav-item"></button>')
                .attr('data-tab', tab.id)
                .append($('<i class="fas"></i>').addClass(tab.icon), $('<span></span>').text(tab.label))
                .click(function () {
                    mobile.hapticImpact();
                    if (tab.id === 'more') {
                        showMoreSheet();
                    } else {
                        selectTab(tab.id);
                    }
                });
            nav.append(button);
        });
        $('body').append(nav);
    }

    function buildAssistantButton() {
        if (!window.cheeseForkAi || api.isViewingSharedSchedule()) {
            return;
        }
        $('body').append($('<button type="button" class="cf-ai-fab" title="עוזר AI"><i class="fas fa-magic"></i></button>').click(function () {
            mobile.hapticImpact();
            window.cheeseForkAi.openAssistant();
        }));
    }

    function buildPanels() {
        $('#course-calendar').before('<div id="cf-app-tasks" class="col-md-10 d-none"></div><div id="cf-app-grades" class="col-md-10 d-none"></div>');
    }

    function updateTasksBadge() {
        var button = $('#cf-app-nav [data-tab=tasks]');
        if (button.length === 0 || !window.cheeseForkTasks) {
            return;
        }
        var count = window.cheeseForkTasks.getTasks('open').filter(function (task) {
            return task.dueDate && (task.dueDate.getTime() < Date.now() || daysUntilDate(task.dueDate) <= 7);
        }).length;
        button.find('.cf-app-nav-badge').remove();
        if (count > 0) {
            button.append($('<span class="cf-app-nav-badge"></span>').text(count));
        }
    }

    function daysUntilDate(date) {
        var now = new Date();
        var a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var b = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        return Math.round((b - a) / (24 * 3600 * 1000));
    }

    function selectTab(tab, silent) {
        state.tab = tab;
        $('#cf-app-nav .cf-app-nav-item').each(function () {
            $(this).toggleClass('cf-app-nav-item-active', $(this).attr('data-tab') === tab);
        });

        var sidebarParts = $('#right-content-bar [data-intro], #general-info, #course-button-list, #course-exam-info-wrapper');
        var gradesPanel = $('#cf-app-grades');
        var tasksPanel = $('#cf-app-tasks');

        if (tab === 'grades' || tab === 'tasks') {
            sidebarParts.addClass('cf-app-hidden');
            $('#cf-mobile-card').addClass('cf-app-hidden');
            $('#course-calendar').addClass('cf-mobile-hidden');
            $('#cf-mobile-agenda').addClass('d-none');
            gradesPanel.toggleClass('d-none', tab !== 'grades');
            tasksPanel.toggleClass('d-none', tab !== 'tasks');
            if (tab === 'grades') {
                renderGradesPanel();
            } else if (window.cheeseForkTasks) {
                window.cheeseForkTasks.renderPanel(tasksPanel);
            }
        } else {
            gradesPanel.addClass('d-none');
            tasksPanel.addClass('d-none');
            $('#cf-mobile-card').removeClass('cf-app-hidden');
            if (tab === 'day') {
                sidebarParts.addClass('cf-app-hidden');
            } else {
                sidebarParts.removeClass('cf-app-hidden');
            }
            mobile.setView(tab === 'day' ? 'day' : 'week', silent);
        }

        if (!silent) {
            trackEvent('app-tab-' + tab);
        }
        window.scrollTo(0, 0);
    }

    function renderGradesPanel() {
        api.renderGrades($('#cf-app-grades'));
    }

    // ---------------------------------------------------------------------
    // Bottom sheets
    // ---------------------------------------------------------------------

    function showSheet(title, content) {
        closeSheet(true);

        var backdrop = $('<div class="cf-app-sheet-backdrop"></div>').click(function () {
            closeSheet();
        });
        var sheet = $('<div class="cf-app-sheet"></div>');
        sheet.append('<div class="cf-app-sheet-handle"></div>');
        if (title) {
            sheet.append($('<div class="cf-app-sheet-title"></div>').text(title));
        }
        sheet.append($('<div class="cf-app-sheet-content"></div>').append(content));

        $('body').append(backdrop, sheet).addClass('cf-app-sheet-open');
        state.sheet = {backdrop: backdrop, sheet: sheet};

        setTimeout(function () {
            backdrop.addClass('cf-app-sheet-visible');
            sheet.addClass('cf-app-sheet-visible');
        }, 10);
    }

    function closeSheet(immediate) {
        if (!state.sheet) {
            return;
        }
        var current = state.sheet;
        state.sheet = null;
        $('body').removeClass('cf-app-sheet-open');
        current.backdrop.removeClass('cf-app-sheet-visible');
        current.sheet.removeClass('cf-app-sheet-visible');
        setTimeout(function () {
            current.backdrop.remove();
            current.sheet.remove();
        }, immediate ? 0 : 250);
    }

    function makeSheetItem(icon, text, onClick, options) {
        options = options || {};
        var item = $('<button type="button" class="cf-app-sheet-item"></button>');
        item.append($('<i class="fas fa-fw"></i>').addClass(icon), $('<span class="cf-app-sheet-item-text"></span>').text(text));
        if (options.badge) {
            item.append($('<span class="badge badge-danger cf-app-sheet-badge"></span>').text(options.badge));
        }
        if (options.value) {
            item.append($('<span class="cf-app-sheet-item-value"></span>').text(options.value));
        }
        if (options.disabled) {
            item.prop('disabled', true);
        }
        item.click(function () {
            closeSheet();
            setTimeout(onClick, 150);
        });
        return item;
    }

    // ---------------------------------------------------------------------
    // "More" sheet: everything the website keeps in its menu
    // ---------------------------------------------------------------------

    function showMoreSheet() {
        var content = $('<div></div>');
        var shared = api.isViewingSharedSchedule();

        var changes = $('#top-navbar-changes');
        if (!changes.hasClass('d-none')) {
            content.append(makeSheetItem('fa-newspaper', 'שינויים בקורסים שלי', function () {
                changes.find('a').click();
            }, {badge: changes.find('.unread-count-badge').text()}));
        }

        if (shared) {
            content.append(makeSheetItem('fa-home', 'המערכת שלי', function () {
                location.href = '.';
            }));
        } else {
            if (!$('#top-navbar-login').hasClass('d-none')) {
                content.append(makeSheetItem('fa-sign-in-alt', 'כניסה לחשבון', function () {
                    $('#top-navbar-login a').click();
                }));
            } else if (!$('#top-navbar-logout').hasClass('d-none')) {
                var who = ($('#top-navbar-logout a').attr('data-original-title') || '').replace(/^מחובר בתור: /, '');
                content.append(makeSheetItem('fa-sign-out-alt', 'יציאה מהחשבון', function () {
                    $('#top-navbar-logout a').click();
                }, {value: who}));
            }
        }

        content.append(makeSheetItem('fa-share-alt', 'שיתוף המערכת', mobile.shareSchedule));

        if (!shared && window.cheeseForkTasks) {
            content.append(makeSheetItem('fa-link', 'חיבור ל-Moodle (מטלות)', window.cheeseForkTasks.showMoodleDialog, {
                value: window.cheeseForkTasks.isMoodleConnected() ? 'מחובר' : ''
            }));
        }
        if (!shared && window.cheeseForkAi) {
            content.append(makeSheetItem('fa-magic', 'עוזר AI - הגדרות', function () {
                window.cheeseForkAi.showSettingsDialog();
            }, {
                value: window.cheeseForkAi.isConfigured() ? window.cheeseForkAi.PROVIDERS[JSON.parse(localStorage.getItem('cheeseForkAi') || '{}').provider || 'gemini'].name : 'לא מוגדר'
            }));
        }

        if (!shared) {
            content.append(makeSheetItem('fa-file-import', 'ייבוא מערכת מקישור', function () {
                mobile.showImportDialog(null);
            }));
        }
        content.append(makeSheetItem('fa-user-friends', 'מתי שנינו פנויים?', mobile.showFreeTimeDialog));

        if (platform.isNative && !shared) {
            content.append(makeSheetItem('fa-bell', 'תזכורות לשיעורים ולמבחנים', mobile.showRemindersDialog));
        }

        content.append(makeSheetItem('fa-file-download', 'ייצוא ל-iCalendar (Google Calendar)', function () {
            $('#top-navbar-export a').click();
        }));

        if (!shared) {
            var undo = $('#top-navbar-undo');
            var redo = $('#top-navbar-redo');
            if (!undo.hasClass('d-none')) {
                content.append(makeSheetItem('fa-redo', 'בטל שינויים', function () {
                    undo.find('a').click();
                }));
            }
            if (!redo.hasClass('d-none')) {
                content.append(makeSheetItem('fa-undo', 'החזר שינויים', function () {
                    redo.find('a').click();
                }));
            }
        }

        content.append('<div class="cf-app-sheet-divider"></div>');

        if (!shared) {
            content.append(makeSheetItem('fa-calendar-alt', 'סמסטר', showSemesterSheet, {
                value: api.semesterFriendlyName(api.currentSemester)
            }));
        }

        content.append(makeSheetItem(isDark() ? 'fa-sun' : 'fa-moon', isDark() ? 'מצב בהיר' : 'מצב כהה', toggleDarkMode));

        content.append(makeSheetItem('fa-sync-alt', 'רענון הנתונים', function () {
            location.reload();
        }));

        content.append('<div class="cf-app-sheet-divider"></div>');

        content.append(makeSheetItem('fa-info-circle', 'אודות CheeseFork', showAboutDialog));

        showSheet(null, content);
    }

    function showSemesterSheet() {
        var content = $('<div></div>');
        Object.keys(api.availableSemesters).sort().reverse().forEach(function (semester) {
            var item = makeSheetItem(semester === api.currentSemester ? 'fa-check' : 'fa-calendar',
                api.semesterFriendlyName(semester), function () {
                    if (semester !== api.currentSemester) {
                        location.href = '?semester=' + encodeURIComponent(semester);
                    }
                });
            if (semester === api.currentSemester) {
                item.addClass('cf-app-sheet-item-current');
            }
            content.append(item);
        });
        showSheet('בחירת סמסטר', content);
    }

    function isDark() {
        var toggle = document.querySelector('dark-mode-toggle');
        if (toggle && toggle.mode) {
            return toggle.mode === 'dark';
        }
        try {
            return window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch (e) {
            return false;
        }
    }

    function toggleDarkMode() {
        var toggle = document.querySelector('dark-mode-toggle');
        if (!toggle) {
            return;
        }
        toggle.mode = isDark() ? 'light' : 'dark';
        trackEvent('app-dark-mode-' + toggle.mode);
    }

    function showAboutDialog() {
        BootstrapDialog.show({
            title: 'אודות',
            message: '<div class="text-center">' +
                    '<img src="logo.png" alt="CheeseFork" height="40"><br><br>' +
                    '<div>CheeseFork - כלי בניית מערכת שעות לסטודנטים בטכניון.</div>' +
                    '<div class="mt-2">תוכנת על ידי <a href="https://github.com/michael-maltsev" target="_blank" rel="noopener">מיכאל מלצב</a>; ' +
                    'האפליקציה והתוספות למובייל מתוחזקות ב-<a href="https://github.com/DavidMasin/cheese-fork" target="_blank" rel="noopener">GitHub</a>.</div>' +
                    '<div class="mt-2"><a href="https://cheesefork.cf/PRIVACY.md" target="_blank" rel="noopener">מדיניות פרטיות</a></div>' +
                '</div>',
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
    // Course sheet (tap on a lesson in the day view)
    // ---------------------------------------------------------------------

    function showCourseSheet(item) {
        trackEvent('app-course-sheet');

        var content = $('<div class="cf-app-course"></div>');

        var line = $('<div class="cf-app-course-line"></div>');
        line.append($('<span class="cf-mobile-item-color"></span>').css('background-color', item.color));
        line.append($('<span></span>').text(
            (item.isCustom ? 'אירוע' : item.type) + ' · יום ' + mobile.DAY_NAMES[item.day] + ' ' +
            mobile.formatMinutes(item.startMin) + '-' + mobile.formatMinutes(item.endMin)));
        content.append(line);

        var location = mobile.makeLocationLink(item);
        if (location) {
            content.append($('<div class="cf-app-course-line"></div>').append(location));
        }
        if (item.staff) {
            content.append($('<div class="cf-app-course-line"></div>').append('<i class="fas fa-fw fa-user"></i> ', $('<span></span>').text(item.staff)));
        }

        if (!item.isCustom) {
            var general = api.getCourseInfo(item.course) || {};

            var exams = mobile.getExams().filter(function (exam) {
                return exam.course === item.course && exam.daysLeft >= 0;
            });
            exams.forEach(function (exam) {
                content.append($('<div class="cf-app-course-line"></div>').append(
                    '<i class="fas fa-fw fa-graduation-cap"></i> ',
                    $('<span></span>').text(exam.moed + ': ' + formatDate(exam.date, exam.hasTime) + ' · ' + mobile.examDaysText(exam))));
            });

            if (general['נקודות']) {
                content.append($('<div class="cf-app-course-line cf-mobile-small"></div>').text(
                    general['נקודות'] + ' נקודות' + (general['פקולטה'] ? ' · ' + general['פקולטה'] : '')));
            }

            var actions = $('<div class="cf-app-course-actions"></div>');
            actions.append(makeActionButton('fa-info-circle', 'מידע, חוות דעת והיסטוגרמות', function () {
                api.openCourseInfo(item.course);
            }));
            actions.append(makeActionButton('fa-external-link-alt', 'Moodle', function () {
                window.open('https://moodle.technion.ac.il/course/search.php?search=' + encodeURIComponent(item.course), '_blank', 'noopener');
            }));
            actions.append(makeActionButton('fa-graduation-cap', 'ציון', function () {
                selectTab('grades');
            }));
            if (window.cheeseForkAi) {
                actions.append(makeActionButton('fa-magic', 'סיכום חוות דעת', function () {
                    window.cheeseForkAi.summarizeCourseFeedback(item.course, null);
                }));
            }
            content.append(actions);

            if (general['סילבוס']) {
                var syllabus = $('<div class="cf-app-course-syllabus cf-mobile-small d-none"></div>').text(general['סילבוס']);
                var toggle = $('<a href="#" class="cf-mobile-small">סילבוס <i class="fas fa-chevron-down"></i></a>').click(function (event) {
                    event.preventDefault();
                    syllabus.toggleClass('d-none');
                });
                content.append($('<div class="cf-app-course-line"></div>').append(toggle), syllabus);
            }
        }

        showSheet(item.name, content);

        function makeActionButton(icon, text, onClick) {
            return $('<button type="button" class="btn btn-sm btn-outline-primary"></button>')
                .append($('<i class="fas"></i>').addClass(icon), ' ', $('<span></span>').text(text))
                .click(function () {
                    closeSheet();
                    setTimeout(onClick, 150);
                });
        }
    }

    function formatDate(date, withTime) {
        var text = ('0' + date.getDate()).slice(-2) + '/' + ('0' + (date.getMonth() + 1)).slice(-2);
        if (withTime) {
            text += ' ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2);
        }
        return text;
    }

    // ---------------------------------------------------------------------
    // Swipe between days in the day view
    // ---------------------------------------------------------------------

    function initSwipe() {
        var startX = null;
        var startY = null;

        var agenda = document.getElementById('cf-mobile-agenda');
        if (!agenda) {
            return;
        }

        agenda.addEventListener('touchstart', function (event) {
            if (event.touches.length !== 1) {
                startX = null;
                return;
            }
            startX = event.touches[0].clientX;
            startY = event.touches[0].clientY;
        }, {passive: true});

        agenda.addEventListener('touchend', function (event) {
            if (startX === null || event.changedTouches.length !== 1) {
                return;
            }
            var dx = event.changedTouches[0].clientX - startX;
            var dy = event.changedTouches[0].clientY - startY;
            startX = null;
            if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) {
                return;
            }
            // RTL: the next day is to the left.
            mobile.shiftAgendaDay(dx < 0 ? 1 : -1);
        }, {passive: true});
    }

    function trackEvent(name) {
        if (typeof gtag === 'function') {
            gtag('event', name);
        }
    }
})();
