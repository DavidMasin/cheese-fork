'use strict';

/* global BootstrapDialog, gtag */

// Private grade book: grades are stored only on this device (localStorage),
// never in the shared schedule, and are shown only inside their own dialog.
// Computes the semester, academic year and cumulative weighted averages.

// eslint-disable-next-line no-unused-vars
var CourseGrades = (function () {
    var STORAGE_KEY = 'cheeseForkGrades';
    var HIDDEN_KEY = 'cheeseForkGradesHidden';
    var PASS_WORDS = ['עבר', 'פטור', 'נכשל'];

    function CourseGrades(options) {
        this.courseManager = options.courseManager;
        this.currentSemester = options.currentSemester;
        this.availableSemesters = options.availableSemesters || {};
        this.semesterFriendlyName = options.semesterFriendlyName;
        this.getSelectedCourses = options.getSelectedCourses;
        this.copyToClipboard = options.copyToClipboard;

        this.dialog = null;
        this.viewSemester = this.currentSemester;
    }

    // ---- storage ---------------------------------------------------------

    function loadData() {
        try {
            var data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (!data.semesters) {
                data.semesters = {};
            }
            return data;
        } catch (e) {
            return {semesters: {}};
        }
    }

    function saveData(data) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            alert('שמירת הציונים נכשלה (אין גישה לאחסון המקומי).');
        }
    }

    function isHidden() {
        try {
            return localStorage.getItem(HIDDEN_KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function setHidden(hidden) {
        try {
            localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0');
        } catch (e) {
            // Ignore.
        }
    }

    // ---- grades math -----------------------------------------------------

    // Returns a number, one of PASS_WORDS, null for empty, or undefined for invalid.
    function parseGrade(text) {
        text = (text || '').trim();
        if (text === '') {
            return null;
        }
        if (PASS_WORDS.indexOf(text) !== -1) {
            return text;
        }
        var number = parseFloat(text.replace(',', '.'));
        if (!isNaN(number) && /^\d+([.,]\d+)?$/.test(text) && number >= 0 && number <= 100) {
            return number;
        }
        return undefined;
    }

    function formatGrade(grade) {
        if (grade === null || grade === undefined) {
            return '';
        }
        if (typeof grade === 'number') {
            return String(Math.round(grade * 10) / 10);
        }
        return grade;
    }

    // Weighted average of the numeric grades; points of passed courses are
    // counted, failed courses are not.
    function computeStats(entries) {
        var weighted = 0;
        var weightedPoints = 0;
        var earnedPoints = 0;
        var count = 0;

        entries.forEach(function (entry) {
            var points = parseFloat(entry.points) || 0;
            if (typeof entry.grade === 'number') {
                weighted += entry.grade * points;
                weightedPoints += points;
                count++;
                if (entry.grade >= 55) {
                    earnedPoints += points;
                }
            } else if (entry.grade === 'עבר' || entry.grade === 'פטור') {
                earnedPoints += points;
                count++;
            } else if (entry.grade === 'נכשל') {
                count++;
            }
        });

        return {
            average: weightedPoints > 0 ? weighted / weightedPoints : null,
            points: earnedPoints,
            count: count
        };
    }

    function entriesOfSemester(data, semester) {
        var courses = data.semesters[semester] || {};
        return Object.keys(courses).map(function (course) {
            return courses[course];
        });
    }

    function academicYear(semester) {
        return semester.slice(0, 4);
    }

    function academicYearName(semester) {
        var year = parseInt(semester.slice(0, 4), 10);
        return year + '-' + (year + 1);
    }

    function formatAverage(stats) {
        return stats.average === null ? '—' : (Math.round(stats.average * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
    }

    function formatPoints(points) {
        return String(Math.round(points * 10) / 10);
    }

    // ---- dialog ----------------------------------------------------------

    CourseGrades.prototype.openDialog = function () {
        var that = this;

        if (that.dialog) {
            return;
        }

        if (typeof gtag === 'function') {
            gtag('event', 'grades-open');
        }

        that.viewSemester = that.currentSemester;

        var content = $('<div class="course-grades"></div>');

        that.dialog = BootstrapDialog.show({
            title: 'הציונים שלי',
            size: BootstrapDialog.SIZE_WIDE,
            message: content,
            onshown: function () {
                that.render(content);
            },
            onhidden: function () {
                that.dialog = null;
            },
            buttons: [{
                label: 'גיבוי',
                action: function () {
                    that.backup();
                }
            }, {
                label: 'שחזור',
                action: function () {
                    that.restore(content);
                }
            }, {
                label: 'סגור',
                cssClass: 'btn-primary',
                action: function (dialog) {
                    dialog.close();
                }
            }]
        });
    };

    // Renders the grade book into a page element (the app's grades tab)
    // instead of a dialog, with the backup/restore actions inline.
    CourseGrades.prototype.renderInline = function (container) {
        var that = this;
        that.viewSemester = that.viewSemester || that.currentSemester;

        var content = $('<div class="course-grades"></div>');
        var actions = $('<div class="course-grades-inline-actions"></div>');
        actions.append($('<button type="button" class="btn btn-sm btn-outline-secondary"><i class="fas fa-download"></i> גיבוי</button>').click(function () {
            that.backup();
        }));
        actions.append($('<button type="button" class="btn btn-sm btn-outline-secondary"><i class="fas fa-file-import"></i> שחזור</button>').click(function () {
            that.restore(content);
        }));

        container.empty().append($('<h5 class="course-grades-inline-title">הציונים שלי</h5>'), content, actions);
        that.render(content);
    };

    CourseGrades.prototype.render = function (container) {
        var that = this;
        var data = loadData();
        var hidden = isHidden();

        if (!/^\d{6}$/.test(that.viewSemester)) {
            that.viewSemester = that.currentSemester;
        }

        container.empty().toggleClass('course-grades-hidden', hidden);

        // Privacy note and hide toggle.
        var toolbar = $('<div class="course-grades-toolbar"></div>');
        toolbar.append($('<span class="text-muted small"><i class="fas fa-lock"></i> הציונים נשמרים במכשיר זה בלבד ואינם חלק מהמערכת המשותפת.</span>'));
        var hideButton = $('<button type="button" class="btn btn-sm btn-outline-secondary"></button>')
            .html(hidden ? '<i class="fas fa-eye"></i> הצג ציונים' : '<i class="fas fa-eye-slash"></i> הסתר ציונים')
            .click(function () {
                setHidden(!isHidden());
                that.render(container);
            });
        toolbar.append(hideButton);
        container.append(toolbar);

        // Stats.
        var semesterStats = computeStats(entriesOfSemester(data, that.viewSemester));
        var yearEntries = [];
        var allEntries = [];
        Object.keys(data.semesters).forEach(function (semester) {
            var entries = entriesOfSemester(data, semester);
            allEntries = allEntries.concat(entries);
            if (academicYear(semester) === academicYear(that.viewSemester)) {
                yearEntries = yearEntries.concat(entries);
            }
        });
        var yearStats = computeStats(yearEntries);
        var totalStats = computeStats(allEntries);

        var stats = $('<div class="row course-grades-stats"></div>');
        stats.append(makeStat('ממוצע סמסטר', that.semesterFriendlyName(that.viewSemester), semesterStats));
        stats.append(makeStat('ממוצע שנתי', academicYearName(that.viewSemester), yearStats));
        stats.append(makeStat('ממוצע מצטבר', 'כל הסמסטרים', totalStats));
        container.append(stats);

        // Semester selector: every semester CheeseFork knows, plus any
        // semester which already has grades.
        var semesters = Object.keys(that.availableSemesters);
        Object.keys(data.semesters).concat([that.currentSemester, that.viewSemester]).forEach(function (semester) {
            if (semesters.indexOf(semester) === -1) {
                semesters.push(semester);
            }
        });
        semesters.sort().reverse();

        var select = $('<select class="form-control form-control-sm course-grades-semester"></select>');
        semesters.forEach(function (semester) {
            var hasGrades = !!data.semesters[semester];
            select.append($('<option>', {
                value: semester,
                text: that.semesterFriendlyName(semester) +
                    (semester === that.currentSemester ? ' (מוצג כעת)' : '') +
                    (hasGrades ? ' ✓' : ''),
                selected: semester === that.viewSemester
            }));
        });
        select.on('change', function () {
            if (!this.value) {
                return;
            }
            that.viewSemester = this.value;
            that.render(container);
        });
        var semesterRow = $('<div class="form-inline course-grades-semester-row"></div>')
            .append('<label class="ml-2">סמסטר:</label>', select);
        if (that.viewSemester !== that.currentSemester && that.availableSemesters[that.viewSemester]) {
            // The courses of another semester are only known once the app shows it.
            semesterRow.append($('<a class="btn btn-sm btn-link course-grades-switch"></a>')
                .text('טעינת המקצועות מהמערכת של סמסטר זה')
                .prop('href', '?semester=' + encodeURIComponent(that.viewSemester)));
        }
        container.append(semesterRow);

        // Table.
        var rows = that.rowsForSemester(data, that.viewSemester);
        var table = $('<table class="table table-sm course-grades-table"></table>');
        table.append('<thead><tr><th>מקצוע</th><th class="course-grades-points-col">נק\'</th><th class="course-grades-grade-col">ציון</th><th></th></tr></thead>');
        var tbody = $('<tbody></tbody>');

        if (rows.length === 0) {
            tbody.append('<tr><td colspan="4" class="text-muted text-center">אין קורסים בסמסטר זה. הוסיפו קורס למטה, או בחרו מקצועות במערכת.</td></tr>');
        }

        rows.forEach(function (row) {
            var tr = $('<tr></tr>').attr('data-course', row.course);
            tr.append($('<td></td>').append(
                $('<span class="course-grades-number"></span>').text(row.course), ' - ',
                $('<span></span>').text(row.name)));
            tr.append($('<td class="course-grades-points-col"></td>').text(formatPoints(parseFloat(row.points) || 0)));

            var input = $('<input type="text" class="form-control form-control-sm course-grades-input course-grades-value" inputmode="decimal" placeholder="ציון / עבר">')
                .val(formatGrade(row.grade));
            input.on('change', function () {
                var grade = parseGrade(this.value);
                if (grade === undefined) {
                    $(this).addClass('is-invalid');
                    return;
                }
                $(this).removeClass('is-invalid');
                that.setGrade(that.viewSemester, row.course, row.name, row.points, grade);
                that.render(container);
            });
            tr.append($('<td class="course-grades-grade-col"></td>').append(input));

            var remove = $('<button type="button" class="btn btn-sm btn-link text-danger" title="הסרה"><i class="fas fa-times"></i></button>')
                .click(function () {
                    that.removeEntry(that.viewSemester, row.course);
                    that.render(container);
                });
            tr.append($('<td></td>').append(row.saved ? remove : ''));
            tbody.append(tr);
        });
        table.append(tbody);
        container.append($('<div class="table-responsive"></div>').append(table));

        // Add course form.
        var form = $('<form class="form-row course-grades-add align-items-end"></form>');
        var numberInput = $('<input type="text" class="form-control form-control-sm" placeholder="מספר מקצוע" inputmode="numeric">');
        var nameInput = $('<input type="text" class="form-control form-control-sm" placeholder="שם המקצוע">');
        var pointsInput = $('<input type="text" class="form-control form-control-sm" placeholder="נק\'" inputmode="decimal">');
        var gradeInput = $('<input type="text" class="form-control form-control-sm" placeholder="ציון" inputmode="decimal">');

        numberInput.on('change blur', function () {
            var course = that.courseManager.stringToCourseNumber(this.value.trim());
            if (!course) {
                return;
            }
            course = that.courseManager.toSemesterFormatCourseNumber(course);
            if (that.courseManager.doesExist(course)) {
                var general = that.courseManager.getGeneralInfo(course);
                if (!nameInput.val()) {
                    nameInput.val(general['שם מקצוע']);
                }
                if (!pointsInput.val()) {
                    pointsInput.val(general['נקודות']);
                }
            } else if (!nameInput.val()) {
                // Course of another semester: look the name up online.
                var newNumber = that.courseManager.toNewCourseNumber(course);
                $.get('https://michael-maltsev.github.io/technion-course-names/num/' + newNumber, function (name) {
                    if (!nameInput.val() && typeof name === 'string') {
                        nameInput.val(name.trim());
                    }
                });
            }
        });

        form.append(
            $('<div class="form-group col-6 col-md-2"></div>').append('<label class="small mb-0">מספר מקצוע</label>', numberInput),
            $('<div class="form-group col-6 col-md-4"></div>').append('<label class="small mb-0">שם</label>', nameInput),
            $('<div class="form-group col-4 col-md-2"></div>').append('<label class="small mb-0">נקודות</label>', pointsInput),
            $('<div class="form-group col-4 col-md-2"></div>').append('<label class="small mb-0">ציון</label>', gradeInput),
            $('<div class="form-group col-4 col-md-2"></div>').append('<button type="submit" class="btn btn-sm btn-outline-primary btn-block">הוספה</button>'));

        form.on('submit', function (event) {
            event.preventDefault();
            var course = that.courseManager.stringToCourseNumber(numberInput.val().trim());
            var name = nameInput.val().trim();
            var points = parseFloat(pointsInput.val().replace(',', '.'));
            var grade = parseGrade(gradeInput.val());
            if (!course || !name || isNaN(points) || grade === undefined) {
                alert('יש למלא מספר מקצוע, שם, נקודות וציון תקינים (0-100, או "עבר"/"פטור"/"נכשל").');
                return;
            }
            that.setGrade(that.viewSemester, that.courseManager.toSemesterFormatCourseNumber(course), name, points, grade, true);
            that.render(container);
        });

        container.append(
            $('<div class="course-grades-add-title">הוספת קורס ידנית</div>'),
            $('<div class="small text-muted mb-1">לסמסטר קודם: בחרו אותו למעלה ולחצו "טעינת המקצועות" כדי לקבל את המקצועות שלכם עם הנקודות, או הוסיפו כאן לפי מספר מקצוע (השם מושלם אוטומטית).</div>'),
            form);

        function makeStat(title, subtitle, stat) {
            var box = $('<div class="col-4"><div class="course-grades-stat"></div></div>');
            var inner = box.find('.course-grades-stat');
            inner.append($('<div class="course-grades-stat-title"></div>').text(title));
            inner.append($('<div class="course-grades-stat-value course-grades-value"></div>').text(formatAverage(stat)));
            inner.append($('<div class="course-grades-stat-sub"></div>').text(subtitle));
            inner.append($('<div class="course-grades-stat-sub course-grades-value"></div>').text(
                formatPoints(stat.points) + ' נק\' · ' + stat.count + ' קורסים'));
            return box;
        }
    };

    // Saved entries of the semester, plus (for the current semester) the
    // courses of the schedule which don't have a grade yet.
    CourseGrades.prototype.rowsForSemester = function (data, semester) {
        var that = this;
        var saved = data.semesters[semester] || {};
        var rows = {};

        Object.keys(saved).forEach(function (course) {
            rows[course] = $.extend({course: course, saved: true}, saved[course]);
        });

        if (semester === that.currentSemester) {
            that.getSelectedCourses().forEach(function (course) {
                if (!rows[course] && that.courseManager.doesExist(course)) {
                    var general = that.courseManager.getGeneralInfo(course);
                    rows[course] = {
                        course: course,
                        name: general['שם מקצוע'],
                        points: parseFloat(general['נקודות']) || 0,
                        grade: null,
                        saved: false
                    };
                }
            });
        }

        return Object.keys(rows).sort().map(function (course) {
            return rows[course];
        });
    };

    CourseGrades.prototype.setGrade = function (semester, course, name, points, grade, keepWithoutGrade) {
        var data = loadData();
        if (!data.semesters[semester]) {
            data.semesters[semester] = {};
        }
        if (grade === null && !keepWithoutGrade) {
            delete data.semesters[semester][course];
            if (Object.keys(data.semesters[semester]).length === 0) {
                delete data.semesters[semester];
            }
        } else {
            data.semesters[semester][course] = {
                name: name,
                points: parseFloat(points) || 0,
                grade: grade
            };
        }
        saveData(data);
    };

    CourseGrades.prototype.removeEntry = function (semester, course) {
        var data = loadData();
        if (data.semesters[semester]) {
            delete data.semesters[semester][course];
            if (Object.keys(data.semesters[semester]).length === 0) {
                delete data.semesters[semester];
            }
        }
        saveData(data);
    };

    CourseGrades.prototype.backup = function () {
        var text = JSON.stringify(loadData());
        var textarea = $('<textarea class="form-control" rows="6" readonly dir="ltr"></textarea>').val(text);
        var that = this;
        BootstrapDialog.show({
            title: 'גיבוי הציונים',
            message: $('<div></div>').append(
                '<p>העתיקו את הטקסט הבא ושמרו אותו במקום בטוח (למשל בפתק). כדי להעביר את הציונים למכשיר אחר, הדביקו אותו שם בחלון "שחזור".</p>',
                textarea),
            buttons: [{
                label: 'העתקה',
                cssClass: 'btn-primary',
                action: function (dialog) {
                    that.copyToClipboard(text, function () {
                        dialog.close();
                    }, function () {
                        textarea.focus().select();
                    });
                }
            }, {
                label: 'סגור',
                action: function (dialog) {
                    dialog.close();
                }
            }]
        });
    };

    CourseGrades.prototype.restore = function (container) {
        var that = this;
        var textarea = $('<textarea class="form-control" rows="6" dir="ltr" placeholder="הדביקו כאן את טקסט הגיבוי"></textarea>');
        BootstrapDialog.show({
            title: 'שחזור ציונים מגיבוי',
            message: $('<div></div>').append('<p>הציונים מהגיבוי יתווספו לציונים הקיימים במכשיר (ציון קיים לאותו קורס יוחלף).</p>', textarea),
            onshown: function () {
                textarea.focus();
            },
            buttons: [{
                label: 'שחזור',
                cssClass: 'btn-primary',
                action: function (dialog) {
                    var parsed;
                    try {
                        parsed = JSON.parse(textarea.val());
                    } catch (e) {
                        parsed = null;
                    }
                    if (!parsed || typeof parsed.semesters !== 'object') {
                        alert('טקסט הגיבוי לא תקין.');
                        return;
                    }
                    var data = loadData();
                    Object.keys(parsed.semesters).forEach(function (semester) {
                        if (!/^\d{6}$/.test(semester)) {
                            return;
                        }
                        data.semesters[semester] = $.extend({}, data.semesters[semester], parsed.semesters[semester]);
                    });
                    saveData(data);
                    dialog.close();
                    that.render(container);
                }
            }, {
                label: 'ביטול',
                action: function (dialog) {
                    dialog.close();
                }
            }]
        });
    };

    return CourseGrades;
})();
