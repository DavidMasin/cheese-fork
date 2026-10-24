'use strict';

/* global moment, BootstrapDialog, firebase, gtag */

// AI helper: an assistant that knows the user's schedule, exams, tasks (and
// grades, if allowed), summaries of course feedback, and task extraction from
// pasted announcements. Works with Gemini (free tier), OpenAI or Claude; the
// API key is stored on the device only and requests go straight to the
// provider from the app.

(function () {
    var STORAGE_KEY = 'cheeseForkAi';
    var CACHE_KEY = 'cheeseForkAiCache';

    var PROVIDERS = {
        gemini: {
            name: 'Google Gemini',
            defaultModel: 'gemini-2.5-flash',
            keyUrl: 'https://aistudio.google.com/app/apikey',
            hint: 'מפתח חינמי מ-Google AI Studio (יש מכסה יומית חינמית).'
        },
        openai: {
            name: 'OpenAI (ChatGPT)',
            defaultModel: 'gpt-4o-mini',
            keyUrl: 'https://platform.openai.com/api-keys',
            hint: 'דורש יתרה בחשבון OpenAI; gpt-4o-mini זול מאוד.'
        },
        anthropic: {
            name: 'Anthropic (Claude)',
            defaultModel: 'claude-opus-5-5',
            keyUrl: 'https://console.anthropic.com/',
            hint: 'claude-opus-5-5 הוא המודל המומלץ; claude-haiku-5-5 זול בהרבה.'
        }
    };

    var api = null;
    var mobile = null;

    var chat = {
        messages: [],
        busy: false,
        dialog: null,
        container: null
    };

    // ---------------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------------

    function getSettings() {
        try {
            return $.extend({provider: 'gemini', apiKey: '', model: '', shareGrades: false},
                JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
        } catch (e) {
            return {provider: 'gemini', apiKey: '', model: '', shareGrades: false};
        }
    }

    function saveSettings(settings) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) {
            // Ignore.
        }
        $(document).trigger('cheesefork:ai-changed');
    }

    function isConfigured() {
        var settings = getSettings();
        return !!(settings.apiKey && PROVIDERS[settings.provider]);
    }

    function modelOf(settings) {
        return settings.model || PROVIDERS[settings.provider].defaultModel;
    }

    function showSettingsDialog(onSaved) {
        trackEvent('ai-settings-open');
        var settings = getSettings();

        var providerSelect = $('<select class="form-control"></select>');
        Object.keys(PROVIDERS).forEach(function (key) {
            providerSelect.append($('<option>', {value: key, text: PROVIDERS[key].name, selected: key === settings.provider}));
        });
        var keyInput = $('<input type="password" class="form-control" dir="ltr" autocomplete="off" placeholder="API key">').val(settings.apiKey);
        var modelInput = $('<input type="text" class="form-control" dir="ltr">').val(settings.model);
        var hint = $('<div class="cf-mobile-small text-muted"></div>');
        var keyLink = $('<a target="_blank" rel="noopener"></a>');
        var shareGrades = $('<input class="form-check-input" type="checkbox" id="cf-ai-share-grades">').prop('checked', !!settings.shareGrades);
        var status = $('<div class="cf-mobile-small mt-2"></div>');

        function refreshProvider() {
            var provider = PROVIDERS[providerSelect.val()];
            modelInput.attr('placeholder', provider.defaultModel);
            hint.text(provider.hint);
            keyLink.text('קבלת מפתח ' + provider.name).prop('href', provider.keyUrl);
        }
        providerSelect.on('change', refreshProvider);
        refreshProvider();

        var message = $('<div></div>').append(
            '<p class="cf-mobile-small">העוזר מקבל את המערכת, המבחנים והמטלות שלכם ועונה בעברית. המפתח נשמר במכשיר זה בלבד, והבקשות נשלחות ישירות מהאפליקציה לספק שבחרתם (ועל חשבונכם, לפי תנאי הספק).</p>',
            $('<div class="form-group"></div>').append('<label class="small mb-0">ספק</label>', providerSelect, hint),
            $('<div class="form-group"></div>').append('<label class="small mb-0">מפתח API</label>', keyInput, $('<div class="cf-mobile-small"></div>').append(keyLink)),
            $('<div class="form-group"></div>').append('<label class="small mb-0">מודל (אופציונלי)</label>', modelInput),
            $('<div class="form-check"></div>').append(shareGrades, '<label class="form-check-label small" for="cf-ai-share-grades">לשתף גם את הציונים שלי עם העוזר</label>'),
            status);

        var dialog = BootstrapDialog.show({
            title: 'עוזר AI - הגדרות',
            message: message,
            buttons: [{
                label: 'בדיקה',
                action: function () {
                    var test = {
                        provider: providerSelect.val(),
                        apiKey: keyInput.val().trim(),
                        model: modelInput.val().trim()
                    };
                    if (!test.apiKey) {
                        status.text('יש להזין מפתח.').addClass('text-danger');
                        return;
                    }
                    status.removeClass('text-danger text-success').text('בודק...');
                    callModel(test, 'ענה במילה אחת: בסדר', []).then(function (text) {
                        status.addClass('text-success').text('החיבור עובד: ' + text.slice(0, 40));
                    }).catch(function (error) {
                        status.addClass('text-danger').text('שגיאה: ' + error.message);
                    });
                }
            }, {
                label: 'שמירה',
                cssClass: 'btn-primary',
                action: function () {
                    saveSettings({
                        provider: providerSelect.val(),
                        apiKey: keyInput.val().trim(),
                        model: modelInput.val().trim(),
                        shareGrades: shareGrades.prop('checked')
                    });
                    dialog.close();
                    if (mobile) {
                        mobile.showToast(isConfigured() ? 'העוזר מוכן' : 'העוזר כבוי (אין מפתח)');
                    }
                    if (onSaved) {
                        onSaved();
                    }
                }
            }, {
                label: 'סגור',
                action: function () {
                    dialog.close();
                }
            }]
        });
    }

    function requireConfigured(then) {
        if (isConfigured()) {
            then();
            return;
        }
        BootstrapDialog.show({
            title: 'עוזר AI',
            message: 'כדי להשתמש בעוזר יש להגדיר ספק ומפתח API (Gemini חינמי). ההגדרה נשמרת במכשיר בלבד.',
            buttons: [{
                label: 'להגדרות',
                cssClass: 'btn-primary',
                action: function (dialog) {
                    dialog.close();
                    showSettingsDialog(then);
                }
            }, {
                label: 'סגור',
                action: function (dialog) {
                    dialog.close();
                }
            }]
        });
    }

    // ---------------------------------------------------------------------
    // Providers (raw HTTP; the app has no bundler for SDKs)
    // ---------------------------------------------------------------------

    function postJson(url, headers, body) {
        return fetch(url, {
            method: 'POST',
            headers: $.extend({'Content-Type': 'application/json'}, headers),
            body: JSON.stringify(body)
        }).then(function (response) {
            return response.text().then(function (text) {
                var data = null;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    // Not JSON.
                }
                if (!response.ok) {
                    var detail = data && (data.error && (data.error.message || data.error.type) || data.message) || text.slice(0, 200);
                    throw new Error('HTTP ' + response.status + (detail ? ' - ' + detail : ''));
                }
                return data;
            });
        }, function () {
            throw new Error('אין תקשורת עם הספק (בדקו חיבור לאינטרנט).');
        });
    }

    // messages: [{role: 'user'|'assistant', text}], returns the reply text.
    function callModel(settings, system, messages) {
        var model = modelOf(settings);

        if (settings.provider === 'gemini') {
            return postJson('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
                {'x-goog-api-key': settings.apiKey},
                {
                    system_instruction: {parts: [{text: system}]},
                    contents: messages.map(function (message) {
                        return {role: message.role === 'assistant' ? 'model' : 'user', parts: [{text: message.text}]};
                    }),
                    generationConfig: {temperature: 0.4, maxOutputTokens: 2048}
                }).then(function (data) {
                var candidate = data.candidates && data.candidates[0];
                var parts = candidate && candidate.content && candidate.content.parts;
                var text = (parts || []).map(function (part) {
                    return part.text || '';
                }).join('').trim();
                if (!text) {
                    throw new Error(candidate && candidate.finishReason ? 'התשובה נחסמה (' + candidate.finishReason + ')' : 'תשובה ריקה');
                }
                return text;
            });
        }

        if (settings.provider === 'openai') {
            return postJson('https://api.openai.com/v1/chat/completions',
                {Authorization: 'Bearer ' + settings.apiKey},
                {
                    model: model,
                    temperature: 0.4,
                    max_tokens: 2048,
                    messages: [{role: 'system', content: system}].concat(messages.map(function (message) {
                        return {role: message.role, content: message.text};
                    }))
                }).then(function (data) {
                var text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
                if (!text) {
                    throw new Error('תשובה ריקה');
                }
                return text.trim();
            });
        }

        if (settings.provider === 'anthropic') {
            return postJson('https://api.anthropic.com/v1/messages',
                {
                    'x-api-key': settings.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'server-side-fallback-2026-07-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                {
                    model: model,
                    max_tokens: 2048,
                    system: system,
                    output_config: {effort: 'low'},
                    fallbacks: 'default',
                    messages: messages.map(function (message) {
                        return {role: message.role, content: message.text};
                    })
                }).then(function (data) {
                if (data.stop_reason === 'refusal') {
                    throw new Error('המודל סירב לענות' + (data.stop_details && data.stop_details.explanation ? ': ' + data.stop_details.explanation : ''));
                }
                var text = (data.content || []).filter(function (block) {
                    return block.type === 'text';
                }).map(function (block) {
                    return block.text;
                }).join('').trim();
                if (!text) {
                    throw new Error('תשובה ריקה');
                }
                return text;
            });
        }

        return Promise.reject(new Error('ספק לא ידוע'));
    }

    // ---------------------------------------------------------------------
    // Context about the student
    // ---------------------------------------------------------------------

    var DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

    function formatMinutes(minutes) {
        return ('0' + Math.floor(minutes / 60) % 24).slice(-2) + ':' + ('0' + minutes % 60).slice(-2);
    }

    function buildContext(options) {
        options = options || {};
        var lines = [];
        var now = new Date();

        lines.push('תאריך ושעה עכשיו: יום ' + DAY_NAMES[now.getDay()] + ' ' + moment(now).format('DD/MM/YYYY HH:mm'));
        lines.push('סמסטר: ' + api.semesterFriendlyName(api.currentSemester));
        var semester = api.availableSemesters[api.currentSemester];
        if (semester) {
            lines.push('הסמסטר מתחיל ב-' + semester.start + ' ומסתיים ב-' + semester.end);
        }

        var courses = api.getSelectedCourses();
        if (courses.length > 0) {
            lines.push('');
            lines.push('הקורסים שלי:');
            courses.forEach(function (course) {
                var general = api.courseManager.getGeneralInfo(course);
                lines.push('- ' + course + ' ' + general['שם מקצוע'] + ' (' + (general['נקודות'] || '?') + ' נק\')' +
                    (general['מועד א'] ? ' | מועד א\': ' + general['מועד א'].split('\n')[0] : '') +
                    (general['מועד ב'] ? ' | מועד ב\': ' + general['מועד ב'].split('\n')[0] : ''));
            });
        }

        if (mobile) {
            var items = mobile.getScheduleItems();
            if (items.length > 0) {
                lines.push('');
                lines.push('מערכת השעות השבועית (השיעורים שבחרתי):');
                items.forEach(function (item) {
                    lines.push('- יום ' + DAY_NAMES[item.day] + ' ' + formatMinutes(item.startMin) + '-' + formatMinutes(item.endMin) +
                        ' ' + item.name + (item.isCustom ? '' : ' (' + item.type + ')') +
                        (item.building ? ' ב' + item.building + (item.room ? ' ' + item.room : '') : '') +
                        (item.staff ? ', ' + item.staff : ''));
                });

                lines.push('');
                lines.push('זמנים פנויים בין 08:30 ל-18:30:');
                for (var day = 0; day < 6; day++) {
                    var busy = items.filter(function (item) {
                        return item.day === day;
                    }).sort(function (a, b) {
                        return a.startMin - b.startMin;
                    });
                    var free = [];
                    var cursor = 8 * 60 + 30;
                    busy.forEach(function (item) {
                        if (item.startMin - cursor >= 30) {
                            free.push(formatMinutes(cursor) + '-' + formatMinutes(item.startMin));
                        }
                        cursor = Math.max(cursor, item.endMin);
                    });
                    if (18 * 60 + 30 - cursor >= 30) {
                        free.push(formatMinutes(cursor) + '-' + formatMinutes(18 * 60 + 30));
                    }
                    lines.push('- יום ' + DAY_NAMES[day] + ': ' + (busy.length === 0 ? 'פנוי כל היום' : free.join(', ') || 'אין'));
                }
            }

            var exams = mobile.getExams().filter(function (exam) {
                return exam.daysLeft >= 0;
            });
            if (exams.length > 0) {
                lines.push('');
                lines.push('מבחנים קרובים:');
                exams.forEach(function (exam) {
                    lines.push('- ' + exam.name + ' ' + exam.moed + ': ' + moment(exam.date).format('DD/MM/YYYY' + (exam.hasTime ? ' HH:mm' : '')) + ' (בעוד ' + exam.daysLeft + ' ימים)');
                });
            }
        }

        if (window.cheeseForkTasks) {
            var tasks = window.cheeseForkTasks.getTasks('open').filter(function (task) {
                return task.dueDate;
            }).slice(0, 30);
            if (tasks.length > 0) {
                lines.push('');
                lines.push('מטלות פתוחות (מ-Moodle וידניות):');
                tasks.forEach(function (task) {
                    lines.push('- ' + task.title + (task.courseName ? ' [' + task.courseName.replace(/^\d+\s*[-–]\s*/, '') + ']' : '') +
                        ' עד ' + moment(task.dueDate).format('DD/MM HH:mm') +
                        (task.dueDate.getTime() < Date.now() ? ' (באיחור!)' : ''));
                });
            }
        }

        if (options.includeGrades) {
            try {
                var grades = JSON.parse(localStorage.getItem('cheeseForkGrades') || '{}').semesters || {};
                var gradeLines = [];
                Object.keys(grades).sort().forEach(function (semesterKey) {
                    Object.keys(grades[semesterKey]).forEach(function (course) {
                        var entry = grades[semesterKey][course];
                        gradeLines.push('- ' + api.semesterFriendlyName(semesterKey) + ': ' + entry.name + ' (' + entry.points + ' נק\') - ' + entry.grade);
                    });
                });
                if (gradeLines.length > 0) {
                    lines.push('');
                    lines.push('הציונים שלי:');
                    lines = lines.concat(gradeLines);
                }
            } catch (e) {
                // Ignore.
            }
        }

        return lines.join('\n');
    }

    function assistantSystemPrompt() {
        var settings = getSettings();
        return 'אתה העוזר האישי של סטודנט/ית בטכניון בתוך האפליקציה CheeseFork (בניית מערכת שעות). ' +
            'ענה בעברית, בקצרה ולעניין, בטון חברי. השתמש רק במידע שבהקשר למטה כשעונים על שאלות על המערכת, המבחנים, המטלות או הציונים; ' +
            'אם משהו חסר, אמור זאת במקום לנחש. כשמבקשים תכנון (למשל שבוע לימודים), הצע תוכנית קונקרטית לפי הזמנים הפנויים, המבחנים והמטלות. ' +
            'אפשר להשתמש ברשימות ובהדגשה (**טקסט**) בלבד, בלי כותרות.\n\n' +
            '=== הקשר ===\n' + buildContext({includeGrades: !!settings.shareGrades});
    }

    // ---------------------------------------------------------------------
    // Assistant chat
    // ---------------------------------------------------------------------

    var QUICK_PROMPTS = [
        'מה יש לי היום?',
        'מה הכי דחוף השבוע?',
        'מתי המבחן הבא ומה יש לי לפניו?',
        'תכנן לי שבוע לימודים לפי הזמנים הפנויים',
        'מתי אני פנוי/ה ביום שלישי?'
    ];

    function openAssistant() {
        trackEvent('ai-assistant-open');
        requireConfigured(function () {
            if (chat.dialog) {
                return;
            }

            var container = $('<div class="cf-ai-chat"></div>');
            var log = $('<div class="cf-ai-log"></div>');
            var quick = $('<div class="cf-ai-quick"></div>');
            QUICK_PROMPTS.forEach(function (prompt) {
                quick.append($('<button type="button" class="btn btn-sm btn-outline-secondary"></button>').text(prompt).click(function () {
                    sendMessage(prompt);
                }));
            });
            var input = $('<textarea class="form-control cf-ai-input" rows="2" placeholder="שאלו אותי על המערכת, המבחנים והמטלות..."></textarea>');
            var send = $('<button type="button" class="btn btn-primary cf-ai-send"><i class="fas fa-paper-plane"></i></button>');
            var composer = $('<div class="cf-ai-composer"></div>').append(input, send);

            container.append(log, quick, composer);
            chat.container = log;

            if (chat.messages.length === 0) {
                appendBubble('assistant', 'היי! אני מכיר את המערכת, המבחנים והמטלות שלך. במה לעזור?', true);
            } else {
                chat.messages.forEach(function (message) {
                    appendBubble(message.role, message.text, true);
                });
            }

            send.click(function () {
                var text = input.val().trim();
                if (text) {
                    input.val('');
                    sendMessage(text);
                }
            });
            input.on('keydown', function (event) {
                if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    send.click();
                }
            });

            chat.dialog = BootstrapDialog.show({
                title: 'עוזר AI',
                cssClass: 'cf-ai-dialog',
                message: container,
                onshown: function () {
                    log.scrollTop(log[0].scrollHeight);
                },
                onhidden: function () {
                    chat.dialog = null;
                    chat.container = null;
                },
                buttons: [{
                    label: 'ניקוי שיחה',
                    action: function () {
                        chat.messages = [];
                        log.empty();
                        appendBubble('assistant', 'התחלנו מחדש. במה לעזור?', true);
                    }
                }, {
                    label: 'הגדרות',
                    action: function () {
                        showSettingsDialog();
                    }
                }, {
                    label: 'סגור',
                    cssClass: 'btn-primary',
                    action: function (dialog) {
                        dialog.close();
                    }
                }]
            });
        });
    }

    function appendBubble(role, text, instant) {
        if (!chat.container) {
            return null;
        }
        var bubble = $('<div class="cf-ai-bubble"></div>').addClass(role === 'user' ? 'cf-ai-bubble-user' : 'cf-ai-bubble-assistant');
        bubble.html(renderMarkdown(text));
        chat.container.append(bubble);
        if (!instant) {
            chat.container.scrollTop(chat.container[0].scrollHeight);
        }
        return bubble;
    }

    function sendMessage(text) {
        if (chat.busy) {
            return;
        }
        chat.busy = true;
        trackEvent('ai-assistant-send');

        chat.messages.push({role: 'user', text: text});
        appendBubble('user', text);
        var typing = appendBubble('assistant', '…');
        typing.addClass('cf-ai-bubble-typing');
        if (chat.container) {
            chat.container.scrollTop(chat.container[0].scrollHeight);
        }

        var history = chat.messages.slice(-12);
        callModel(getSettings(), assistantSystemPrompt(), history).then(function (reply) {
            chat.messages.push({role: 'assistant', text: reply});
            typing.removeClass('cf-ai-bubble-typing').html(renderMarkdown(reply));
        }).catch(function (error) {
            chat.messages.pop();
            typing.removeClass('cf-ai-bubble-typing').addClass('cf-ai-bubble-error').text('שגיאה: ' + error.message);
        }).then(function () {
            chat.busy = false;
            if (chat.container) {
                chat.container.scrollTop(chat.container[0].scrollHeight);
            }
        });
    }

    // Minimal, safe markdown: paragraphs, bullets, bold.
    function renderMarkdown(text) {
        var escaped = $('<div>').text(text).html();
        var lines = escaped.split('\n');
        var html = '';
        var inList = false;
        lines.forEach(function (line) {
            var bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
            if (bullet) {
                if (!inList) {
                    html += '<ul>';
                    inList = true;
                }
                html += '<li>' + bullet[1] + '</li>';
            } else {
                if (inList) {
                    html += '</ul>';
                    inList = false;
                }
                if (line.trim() !== '') {
                    html += '<p>' + line.replace(/^#+\s*/, '') + '</p>';
                }
            }
        });
        if (inList) {
            html += '</ul>';
        }
        return html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    }

    // ---------------------------------------------------------------------
    // Course feedback summary
    // ---------------------------------------------------------------------

    function loadCache() {
        try {
            return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function saveCache(cache) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch (e) {
            // Ignore.
        }
    }

    function loadFeedbackPosts(course) {
        if (typeof firebase === 'undefined' || !firebase.firestore) {
            return Promise.reject(new Error('Firebase לא זמין'));
        }
        var newNumber = api.courseManager.toNewCourseNumber(course);
        return firebase.firestore().collection('courseFeedback').doc(newNumber).get().then(function (doc) {
            return doc.exists ? (doc.data().posts || []) : [];
        });
    }

    function summarizeCourseFeedback(course, posts) {
        trackEvent('ai-feedback-summary');
        requireConfigured(function () {
            var title = api.courseManager.doesExist(course) ? api.courseManager.getTitle(course) : course;
            var body = $('<div class="cf-ai-summary"><div class="text-muted">מסכם את חוות הדעת...</div></div>');
            var dialog = BootstrapDialog.show({
                title: 'סיכום חוות דעת - ' + title,
                message: body,
                buttons: [{
                    label: 'סגור',
                    cssClass: 'btn-primary',
                    action: function (d) {
                        d.close();
                    }
                }]
            });

            var postsPromise = posts ? Promise.resolve(posts) : loadFeedbackPosts(course);
            postsPromise.then(function (list) {
                if (!list || list.length === 0) {
                    body.html('<div>אין חוות דעת לקורס זה.</div>');
                    return null;
                }

                var settings = getSettings();
                var cacheKey = course + ':' + list.length + ':' + settings.provider + ':' + modelOf(settings);
                var cache = loadCache();
                if (cache[cacheKey]) {
                    body.html(renderMarkdown(cache[cacheKey]));
                    return null;
                }

                var text = list.slice(-40).map(function (post, i) {
                    var semester = post.semester ? api.semesterFriendlyName(post.semester) : '';
                    return '[' + (i + 1) + '] ' + semester +
                        (post.generalRank ? ' | דירוג כללי ' + post.generalRank + '/5' : '') +
                        (post.difficultyRank ? ' | עומס ' + post.difficultyRank + '/5' : '') +
                        '\n' + (post.text || '').slice(0, 1500);
                }).join('\n\n');

                var system = 'אתה מסכם חוות דעת של סטודנטים על קורס בטכניון עבור סטודנט ששוקל לקחת אותו. ' +
                    'כתוב בעברית, תמציתי (עד ~180 מילים), במבנה: שורה תחתונה (משפט), מרצים ותרגולים, עומס ושיעורי בית, מבחן, טיפים. ' +
                    'ציין אם הדעות חלוקות או משתנות בין סמסטרים/מרצים, והסתמך רק על חוות הדעת שניתנו. השתמש ברשימה עם **כותרות מודגשות** בלבד.';
                return callModel(settings, system, [{role: 'user', text: 'הקורס: ' + title + '\n\nחוות הדעת (' + list.length + '):\n\n' + text}])
                    .then(function (summary) {
                        cache[cacheKey] = summary;
                        saveCache(cache);
                        body.html(renderMarkdown(summary));
                        body.append('<div class="cf-mobile-small text-muted mt-2">סיכום אוטומטי לפי ' + list.length + ' חוות דעת. כדאי לקרוא גם את המקור.</div>');
                    });
            }).catch(function (error) {
                body.html($('<div class="text-danger"></div>').text('שגיאה: ' + error.message));
            });

            dialog.getModalBody().css('min-height', '6rem');
        });
    }

    // ---------------------------------------------------------------------
    // Task extraction from pasted text
    // ---------------------------------------------------------------------

    function extractTasksDialog() {
        trackEvent('ai-extract-open');
        requireConfigured(function () {
            var textarea = $('<textarea class="form-control" rows="6" placeholder="הדביקו הודעה מהמרצה, הודעת Moodle, מייל או הודעת וואטסאפ עם מועדי הגשה..."></textarea>');
            var result = $('<div class="mt-2"></div>');
            var found = [];

            var dialog = BootstrapDialog.show({
                title: 'חילוץ מטלות מטקסט (AI)',
                message: $('<div></div>').append(textarea, result),
                buttons: [{
                    id: 'extract',
                    label: 'חילוץ',
                    cssClass: 'btn-primary',
                    action: extract
                }, {
                    id: 'add',
                    label: 'הוספת המסומנות',
                    action: function () {
                        var added = 0;
                        result.find('input[type=checkbox]:checked').each(function () {
                            var task = found[parseInt($(this).attr('data-index'), 10)];
                            window.cheeseForkTasks.addTask(task);
                            added++;
                        });
                        dialog.close();
                        if (mobile) {
                            mobile.showToast('נוספו ' + added + ' מטלות');
                        }
                    }
                }, {
                    label: 'סגור',
                    action: function () {
                        dialog.close();
                    }
                }],
                onshow: function (d) {
                    d.getButton('add').disable();
                }
            });

            function extract() {
                var text = textarea.val().trim();
                if (!text) {
                    return;
                }
                result.html('<div class="text-muted">מחלץ...</div>');
                dialog.getButton('extract').disable();

                var courses = api.getSelectedCourses().map(function (course) {
                    return course + ' = ' + api.courseManager.getGeneralInfo(course)['שם מקצוע'];
                }).join('\n');

                var system = 'חלץ מהטקסט מטלות עם מועדי הגשה. היום: ' + moment().format('YYYY-MM-DD') + ' (יום ' + DAY_NAMES[new Date().getDay()] + '). ' +
                    'החזר JSON בלבד, בלי הסברים, במבנה: {"tasks":[{"title":"...","due":"YYYY-MM-DDTHH:mm","course":"<מספר מקצוע מהרשימה או null>","notes":"..."}]}. ' +
                    'אם אין שעה, השתמש ב-23:59. אם אין שנה, בחר את התאריך הקרוב בעתיד. אם אין מטלות, החזר {"tasks":[]}.\n\nהקורסים של הסטודנט:\n' + courses;

                callModel(getSettings(), system, [{role: 'user', text: text}]).then(function (reply) {
                    var json = reply.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
                    var start = json.indexOf('{');
                    var end = json.lastIndexOf('}');
                    var parsed = JSON.parse(json.slice(start, end + 1));
                    found = (parsed.tasks || []).filter(function (task) {
                        return task && task.title;
                    }).map(function (task) {
                        var course = task.course && api.courseManager.doesExist(String(task.course)) ? String(task.course) : null;
                        return {
                            title: String(task.title).trim(),
                            due: task.due && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(task.due) ? task.due.slice(0, 16) : null,
                            course: course,
                            courseName: course ? api.courseManager.getGeneralInfo(course)['שם מקצוע'] : '',
                            notes: task.notes ? String(task.notes).slice(0, 500) : ''
                        };
                    });

                    result.empty();
                    if (found.length === 0) {
                        result.html('<div>לא נמצאו מטלות בטקסט.</div>');
                        return;
                    }
                    found.forEach(function (task, i) {
                        var row = $('<div class="form-check cf-ai-task"></div>');
                        row.append($('<input class="form-check-input" type="checkbox" checked>').attr('id', 'cf-ai-task-' + i).attr('data-index', i));
                        row.append($('<label class="form-check-label"></label>').attr('for', 'cf-ai-task-' + i).append(
                            $('<span class="font-weight-bold"></span>').text(task.title),
                            $('<span class="cf-mobile-small text-muted"></span>').text(
                                (task.courseName ? ' · ' + task.courseName : '') +
                                (task.due ? ' · ' + moment(task.due).format('DD/MM HH:mm') : ' · ללא תאריך'))));
                        result.append(row);
                    });
                    dialog.getButton('add').enable();
                }).catch(function (error) {
                    result.html($('<div class="text-danger"></div>').text('שגיאה: ' + error.message));
                }).then(function () {
                    dialog.getButton('extract').enable();
                });
            }
        });
    }

    // ---------------------------------------------------------------------
    // Hooks
    // ---------------------------------------------------------------------

    function trackEvent(name) {
        if (typeof gtag === 'function') {
            gtag('event', name);
        }
    }

    function init() {
        api = window.cheeseFork;
        mobile = window.cheeseForkMobile;

        // "AI summary" button in the course info dialog's feedback section.
        $(document).on('cheesefork:feedback-rendered', function (event, course, posts, element) {
            if (!posts || posts.length === 0) {
                return;
            }
            var button = $('<button type="button" class="btn btn-sm btn-outline-primary mr-2"><i class="fas fa-magic"></i> סיכום AI</button>')
                .click(function () {
                    summarizeCourseFeedback(course, posts);
                });
            $(element).find('#course-feedback-summary').append($('<div class="mt-2"></div>').append(button));
        });
    }

    window.cheeseForkAi = {
        isConfigured: isConfigured,
        showSettingsDialog: showSettingsDialog,
        openAssistant: openAssistant,
        summarizeCourseFeedback: summarizeCourseFeedback,
        extractTasksDialog: extractTasksDialog,
        PROVIDERS: PROVIDERS
    };

    $(function () {
        if (window.cheeseForkMobile) {
            init();
        } else {
            $(document).one('cheesefork:mobile-ready', init);
        }
    });
})();
