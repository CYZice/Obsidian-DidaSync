import { App } from 'obsidian';
import DidaSyncPlugin from '../main';
import { formatYearMonth, resolveUiLocale } from '../i18n';
import { resolveTaskIndex } from '../taskIndex';
import { getDidaTaskPath, getDidaTaskTreeKeys } from '../taskTree';
import { DidaTask, INBOX_PROJECT_NAME } from '../types';
import { debounce, setIconElement, setTextWithIcon, translateRepeatFlag } from '../utils';
import { AddTaskModal } from './AddTaskModal';
import { DatePickerModal } from './DatePickerModal';

export class TimelineViewModal {
    app: App;
    plugin: DidaSyncPlugin;
    currentDate: Date;
    selectedDate: Date;
    isCalendarExpanded: boolean;
    displayYear: number;
    displayMonth: number;
    windowElement: HTMLElement | null;
    overlayElement: HTMLElement | null;
    contentEl: HTMLElement | null;
    eventCleanupHandlers: (() => void)[];

    constructor(app: App, plugin: DidaSyncPlugin) {
        this.app = app;
        this.plugin = plugin;
        this.currentDate = new Date();
        this.selectedDate = new Date();
        this.isCalendarExpanded = false;
        this.displayYear = new Date().getFullYear();
        this.displayMonth = new Date().getMonth();
        this.windowElement = null;
        this.overlayElement = null;
        this.contentEl = null;
        this.eventCleanupHandlers = [];
        this.handleKeydown = this.handleKeydown.bind(this);
    }

    private renderChildCountBadge(element: HTMLElement, completedCount: number, totalCount: number) {
        element.empty();
        element.addClass("dida-child-task-count-static");

        const branchIcon = element.createSpan({ cls: "dida-child-task-count-icon" });
        setIconElement(branchIcon, "git-branch-plus");

        element.createSpan({
            cls: "dida-child-task-count-label",
            text: `${completedCount}/${totalCount}`
        });
    }

    private getTaskPathLabel(task: DidaTask): string {
        try {
            return getDidaTaskPath(task, this.plugin.settings.tasks || [], this.plugin.t("common.untitledTask"));
        } catch (error) {
            return task.title || this.plugin.t("common.untitledTask");
        }
    }

    private getParentTaskLabel(task: DidaTask): string | null {
        if (!task.parentId) return null;
        const parent = (this.plugin.settings.tasks || []).find((candidate) => {
            const keys = getDidaTaskTreeKeys(candidate);
            return keys.includes(task.parentId!);
        });
        return parent?.title || null;
    }

    renderTimelineTaskTitleContent(container: HTMLElement, content: string) {
        while (container.firstChild) container.removeChild(container.firstChild);

        const footnoteRegex = /\[\^([^\]]+)\]/g;
        let lastIndex = 0;
        let match;

        const processText = (parent: HTMLElement, text: string) => {
            if (text) {
                const tagRegex = /#[^\s#]+/g;
                let tagLastIndex = 0;
                let tagMatch;

                while ((tagMatch = tagRegex.exec(text)) !== null) {
                    if (tagMatch.index > tagLastIndex) {
                        parent.appendChild(document.createTextNode(text.slice(tagLastIndex, tagMatch.index)));
                    }
                    parent.createSpan({
                        cls: "dida-task-tag",
                        text: tagMatch[0]
                    });
                    tagLastIndex = tagMatch.index + tagMatch[0].length;
                }

                if (tagLastIndex < text.length) {
                    parent.appendChild(document.createTextNode(text.slice(tagLastIndex)));
                }
            }
        };

        while ((match = footnoteRegex.exec(content)) !== null) {
            if (match.index > lastIndex) {
                processText(container, content.slice(lastIndex, match.index));
            }
            container.createEl("sup", {
                cls: "dida-task-footnote"
            }).textContent = `[${match[1]}]`;
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < content.length) {
            processText(container, content.slice(lastIndex));
        }
    }

    open() {
        this.createCustomWindow();
        this.renderTimelineView();
        document.addEventListener("keydown", this.handleKeydown);
    }

    async close() {
        if (this.windowElement) {
            this.windowElement.remove();
            this.windowElement = null;
        }
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
        this.contentEl = null;
        document.removeEventListener("keydown", this.handleKeydown);

        if (this.eventCleanupHandlers) {
            this.eventCleanupHandlers.forEach(h => h());
            this.eventCleanupHandlers = [];
        }
    }

    handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape" || e.key === "Esc") {
            this.close();
        }
    }

    createCustomWindow() {
        this.overlayElement = document.body.createDiv("dida-timeline-custom-window-overlay");
        this.overlayElement.onclick = () => this.close();

        this.windowElement = document.body.createDiv("dida-timeline-custom-window");
        const header = this.windowElement.createDiv("dida-timeline-custom-window-header");

        const title = header.createEl("h2", {
            cls: "dida-timeline-custom-window-title"
        });
        setTextWithIcon(title, this.plugin.t("timeline.title"), "calendar-check");

        const closeBtn = header.createEl("button", {
            cls: "dida-timeline-custom-window-close"
        });
        setIconElement(closeBtn, "x");
        closeBtn.onclick = () => this.close();

        this.contentEl = this.windowElement.createDiv("dida-timeline-custom-window-content");
        this.windowElement.onclick = (e) => e.stopPropagation();
    }

    renderTimelineView() {
        if (!this.contentEl) return;
        this.contentEl.empty();
        this.renderDateSelector(this.contentEl);
        this.renderTimelineTasks(this.contentEl);
    }

    renderDateSelector(container: HTMLElement) {
        const selector = container.createDiv("dida-timeline-date-selector");
        const nav = selector.createDiv("dida-timeline-month-nav");
        nav.createEl("button", {
            text: "<",
            cls: "dida-timeline-nav-btn"
        }).onclick = () => {
            this.displayMonth--;
            if (this.displayMonth < 0) {
                this.displayMonth = 11;
                this.displayYear--;
            }
            const currentDay = this.selectedDate ? this.selectedDate.getDate() : 1;
            let newDate = new Date(this.displayYear, this.displayMonth, currentDay);
            if (isNaN(newDate.getTime()) || newDate.getMonth() !== this.displayMonth) {
                newDate = new Date(this.displayYear, this.displayMonth, 1);
            }
            this.selectedDate = newDate;
            this.renderTimelineView();
        };

        nav.createDiv("dida-timeline-month-display").setText(
            formatYearMonth(this.displayYear, this.displayMonth, this.plugin.getUiLanguage())
        );

        nav.createEl("button", {
            text: ">",
            cls: "dida-timeline-nav-btn"
        }).onclick = () => {
            this.displayMonth++;
            if (this.displayMonth > 11) {
                this.displayMonth = 0;
                this.displayYear++;
            }
            const currentDay = this.selectedDate ? this.selectedDate.getDate() : 1;
            let newDate = new Date(this.displayYear, this.displayMonth, currentDay);
            if (isNaN(newDate.getTime()) || newDate.getMonth() !== this.displayMonth) {
                newDate = new Date(this.displayYear, this.displayMonth, 1);
            }
            this.selectedDate = newDate;
            this.renderTimelineView();
        };

        nav.createEl("button", {
            text: this.isCalendarExpanded ? "\u6536\u8d77" : "\u5c55\u5f00",
            cls: "dida-timeline-expand-btn"
        }).onclick = () => {
            this.isCalendarExpanded = !this.isCalendarExpanded;
            this.renderTimelineView();
        };

        const weekHeader = selector.createDiv("dida-timeline-week-header");
        ["\u65e5", "\u4e00", "\u4e8c", "\u4e09", "\u56db", "\u4e94", "\u516d"].forEach(d => {
            weekHeader.createEl("span", {
                text: d,
                cls: "dida-timeline-week-day"
            });
        });

        const datePicker = selector.createDiv("dida-timeline-date-picker");
        this.renderDatePicker(datePicker);
    }

    renderDatePicker(container: HTMLElement) {
        const today = new Date();
        const selected = this.selectedDate;

        if (this.isCalendarExpanded) {
            this.renderFullMonth(container, today, selected);
        } else {
            this.renderCurrentWeek(container, today, selected);
        }
    }

    renderFullMonth(container: HTMLElement, today: Date, selected: Date) {
        const firstDay = new Date(this.displayYear, this.displayMonth, 1);
        const lastDay = new Date(this.displayYear, this.displayMonth + 1, 0);

        const start = new Date(firstDay);
        start.setDate(start.getDate() - firstDay.getDay()); // Start from Sunday

        const end = new Date(lastDay);
        end.setDate(end.getDate() + (6 - lastDay.getDay())); // End on Saturday

        // Calculate weeks needed
        const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        const weeks = Math.ceil(diffDays / 7);

        for (let w = 0; w < weeks; w++) {
            for (let d = 0; d < 7; d++) {
                const date = new Date(start);
                date.setDate(start.getDate() + (w * 7) + d);
                this.createDateItem(container, date, today, selected);
            }
        }
    }

    renderCurrentWeek(container: HTMLElement, today: Date, selected: Date) {
        const start = new Date(selected);
        start.setDate(selected.getDate() - selected.getDay());

        for (let i = 0; i < 7; i++) {
            const date = new Date(start);
            date.setDate(start.getDate() + i);
            this.createDateItem(container, date, today, selected);
        }
    }

    createDateItem(container: HTMLElement, date: Date, today: Date, selected: Date) {
        const item = container.createDiv("dida-timeline-date-item");
        item.createEl("span", {
            text: date.getDate().toString(),
            cls: "dida-timeline-date-number"
        });

        const tasks = this.getTasksForDate(date);
        const totalCount = tasks.length;

        const completed = tasks.filter(t => t.status === 2 || (t.completedTime && String(t.completedTime).trim() !== ""));
        const incomplete = tasks.filter(t => !completed.includes(t));

        const pendingCount = incomplete.length;
        const doneCount = completed.length;

        if (totalCount > 0) {
            const countDiv = item.createDiv("dida-timeline-task-count");
            countDiv.setCssStyles({
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                gap: "2px",
                fontSize: "8px",
                color: "var(--text-muted)",
                lineHeight: "1"
            });

            const maxDots = 10;
            if (totalCount > maxDots) {
                countDiv.createEl("span", {
                    text: "+" + totalCount,
                    cls: "dida-timeline-task-more"
                }).setCssStyles({
                    fontSize: "7px",
                    color: "var(--text-muted)",
                    lineHeight: "1",
                    fontWeight: "bold"
                });
            } else {
                const rows = Math.ceil(Math.min(totalCount, maxDots) / 5);
                let p = Math.min(pendingCount, maxDots);
                let d = Math.min(doneCount, Math.max(0, maxDots - p));

                for (let r = 0; r < rows; r++) {
                    const rowDiv = countDiv.createDiv("dida-timeline-task-dots-row");
                    rowDiv.setCssStyles({
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "center",
                        gap: "1px",
                        lineHeight: "1"
                    });

                    const start = r * 5;
                    const end = Math.min(start + 5, Math.min(totalCount, maxDots));

                    for (let k = start; k < end; k++) {
                        let cls = "dida-timeline-task-dot";
                        let isDone = false;

                        if (p > 0) {
                            p--;
                        } else if (d > 0) {
                            d--;
                            cls += " dida-timeline-task-dot-completed";
                            isDone = true;
                        }

                        const dot = rowDiv.createEl("span", { text: "•", cls: cls });
                        dot.setCssStyles({
                            fontSize: "10px",
                            lineHeight: "1",
                            fontWeight: "bold"
                        });
                        if (isDone) dot.title = this.plugin.t("timeline.completedDot");
                    }
                }
            }
            countDiv.title = this.plugin.t("timeline.taskCount", { count: totalCount });
        }

        if (this.isCalendarExpanded && date.getMonth() !== this.displayMonth) {
            item.addClass("dida-timeline-other-month");
        }

        if (date.toDateString() === today.toDateString()) {
            item.addClass("dida-timeline-today");
        }

        if (date.toDateString() === selected.toDateString()) {
            item.addClass("dida-timeline-selected");
        }

        item.onclick = () => {
            this.selectedDate = date;
            this.renderTimelineView();
        };
    }

    getTasksForDate(date: Date): DidaTask[] {
        const tasks = this.plugin.settings.tasks || [];
        const target = new Date(date);
        target.setHours(0, 0, 0, 0);

        return tasks.filter(t => {
            if (!t.dueDate) return false;
            const d = new Date(t.dueDate);
            d.setHours(0, 0, 0, 0);
            return d.getTime() === target.getTime();
        });
    }

    renderTimelineTasks(container: HTMLElement) {
        const timelineContainer = container.createDiv("dida-timeline-container");
        const list = timelineContainer.createDiv("dida-timeline-task-list");

        const tasks = this.getTasksForDate(this.selectedDate);
        const allDayTasks = tasks.filter(t => this.isAllDayTask(t));
        const timeTasks = tasks.filter(t => !this.isAllDayTask(t));

        if (allDayTasks.length > 0) {
            this.renderAllDayTasks(list, allDayTasks);
        }

        if (timeTasks.length > 0) {
            this.renderTimeTasks(list, timeTasks);
        }

        if (tasks.length === 0) {
            list.createDiv("dida-timeline-empty-state").createEl("p", { text: this.plugin.t("timeline.noTasksToday") });
        }

        this.renderFloatingActionButton(container);
    }

    isAllDayTask(task: DidaTask): boolean {
        if (!task.dueDate) return false;
        if (task.isAllDay !== undefined) return task.isAllDay;
        const d = new Date(task.dueDate);
        return d.getHours() === 0 && d.getMinutes() === 0;
    }

    renderAllDayTasks(container: HTMLElement, tasks: DidaTask[]) {
        const section = container.createDiv("dida-timeline-all-day-section");
        const list = section.createDiv("dida-timeline-all-day-tasks");

        tasks.forEach(task => {
            const item = list.createDiv("dida-timeline-task-item dida-timeline-all-day-task");
            item.setAttribute("data-task-id", task.id);

            const elementContainer = item.createDiv("dida-timeline-element-container");
            elementContainer.createDiv("dida-timeline-time-label").textContent = this.plugin.t("schedule.allDay");

            const cb = elementContainer.createEl("input", { type: "checkbox" });
            cb.checked = task.status === 2;

            const titleStack = item.createDiv("dida-timeline-task-main");
            const titleSpan = titleStack.createEl("span", {
                cls: task.status === 2 ? "dida-timeline-task-completed dida-task-title-clickable" : "dida-timeline-task-title dida-task-title-clickable"
            });
            this.renderTimelineTaskTitleContent(titleSpan, task.title || this.plugin.t("common.untitledTask"));
            titleSpan.title = this.getTaskPathLabel(task);

            titleSpan.onclick = () => this.toggleTimelineTaskDetails(item, task);

            const parentLabel = this.getParentTaskLabel(task);
            if (parentLabel) {
                titleStack.createEl("span", {
                    cls: "dida-timeline-parent-label",
                    text: `↳ ${parentLabel}`
                });
            }

            if (task.repeatFlag && task.repeatFlag.trim() !== "") {
                const repeatText = translateRepeatFlag(task.repeatFlag, this.plugin.getUiLanguage());
                if (repeatText) {
                    const rDiv = document.createElement("div");
                    rDiv.className = "dida-task-repeat-rule";
                    setTextWithIcon(rDiv, repeatText.label, repeatText.icon, { textFirst: true });
                    rDiv.addClass("dida-repeat-inline-meta");
                    item.appendChild(rDiv);
                }
            }

            cb.onchange = debounce(async () => {
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId || t.id === task.id);
                if (idx !== -1) {
                    await this.plugin.toggleTask(idx);
                    if (cb.checked) {
                        titleSpan.classList.remove("dida-timeline-task-title");
                        titleSpan.classList.add("dida-timeline-task-completed");
                    } else {
                        titleSpan.classList.remove("dida-timeline-task-completed");
                        titleSpan.classList.add("dida-timeline-task-title");
                    }
                }
            }, 200);

            if (task.items && task.items.length > 0) {
                const activeCount = task.items.filter((i: any) => i.status === 1).length;
                const subSpan = item.createEl("span", { cls: "dida-subtask-count" });
                setTextWithIcon(subSpan, `${activeCount}/${task.items.length}`, "list-todo");
                subSpan.addClass("dida-task-count-base", "dida-task-count-sub");
                subSpan.title = this.plugin.t("timeline.checkItemsHint");
                subSpan.onclick = () => this.toggleTimelineTaskDetails(item, task, "check-items-tab");
            }

            const childTasks = this.plugin.settings.tasks.filter(t => t.parentId === task.didaId);
            if (task.didaId && childTasks.length > 0) {
                const completedChilds = childTasks.filter(t => t.status === 2).length;
                const childSpan = item.createEl("span", { cls: "dida-child-task-count" });
                childSpan.addClass("dida-task-count-base", "dida-task-count-child", "dida-child-task-count-static");
                this.renderChildCountBadge(childSpan, completedChilds, childTasks.length);
                childSpan.title = this.plugin.t("timeline.subtaskCount");
            }

            const dateSpan = item.createEl("span", { cls: "dida-task-due-date" });
            if (task.dueDate) {
                try {
                    const d = new Date(task.dueDate);
                    const m = d.getMonth() + 1;
                    const day = d.getDate();
                    dateSpan.textContent = `${m}/${day}`;

                    const now = new Date();
                    now.setHours(0, 0, 0, 0);
                    d.setHours(0, 0, 0, 0);

                    if (d < now) dateSpan.classList.add("overdue");
                    else if (d.getTime() === now.getTime()) dateSpan.classList.add("today");
                } catch (e) {
                    dateSpan.textContent = "";
                }
            } else {
                setIconElement(dateSpan, "calendar-x-2");
                dateSpan.classList.add("no-date");
            }

            dateSpan.addClass("dida-clickable-date");
            dateSpan.title = this.plugin.t("timeline.setDueDate");
            dateSpan.onclick = (e) => {
                e.stopPropagation();
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId || t.id === task.id);
                if (idx !== -1) {
                    const d = task.startDate || task.dueDate || this.selectedDate;
                    new DatePickerModal(this.app, new Date(d), async (date, isAllDay, endDate, repeatFlag) => {
                        await this.updateTimelineTaskSchedule(idx, date, isAllDay, endDate, repeatFlag);
                    }, e.currentTarget as HTMLElement, this.plugin, idx).open();
                }
            };

            const delBtn = item.createEl("button", { cls: "dida-task-delete" });
            setIconElement(delBtn, "x");
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (confirm(this.plugin.t("timeline.deleteConfirm", { title: task.title }))) {
                    const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId || t.id === task.id);
                    if (idx !== -1) {
                        await this.plugin.deleteTask(idx);
                        this.renderTimelineView();
                    }
                }
            };
        });
    }

    renderTimeTasks(container: HTMLElement, tasks: DidaTask[]) {
        tasks.sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());
        tasks.forEach(task => {
            const item = container.createDiv("dida-timeline-task-item dida-timeline-time-task");
            item.setAttribute("data-task-id", task.id);

            const elementContainer = item.createDiv("dida-timeline-element-container");
            const timeLabel = elementContainer.createDiv("dida-timeline-time-label");
            const timeStr = new Date(task.startDate || task.dueDate!).toLocaleTimeString(resolveUiLocale(this.plugin.getUiLanguage()), {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false
            });
            timeLabel.textContent = timeStr;

            const cb = elementContainer.createEl("input", { type: "checkbox" });
            cb.checked = task.status === 2;
            const titleStack = item.createDiv("dida-timeline-task-main");
            const titleSpan = titleStack.createEl("span", {
                cls: task.status === 2 ? "dida-timeline-task-completed dida-task-title-clickable" : "dida-timeline-task-title dida-task-title-clickable"
            });
            this.renderTimelineTaskTitleContent(titleSpan, task.title || this.plugin.t("common.untitledTask"));
            titleSpan.title = this.getTaskPathLabel(task);
            titleSpan.onclick = () => this.toggleTimelineTaskDetails(item, task);

            const parentLabel = this.getParentTaskLabel(task);
            if (parentLabel) {
                titleStack.createEl("span", {
                    cls: "dida-timeline-parent-label",
                    text: `↳ ${parentLabel}`
                });
            }

            if (task.repeatFlag && task.repeatFlag.trim() !== "") {
                const repeatText = translateRepeatFlag(task.repeatFlag, this.plugin.getUiLanguage());
                if (repeatText) {
                    const rDiv = document.createElement("div");
                    rDiv.className = "dida-task-repeat-rule";
                    setTextWithIcon(rDiv, repeatText.label, repeatText.icon, { textFirst: true });
                    rDiv.addClass("dida-repeat-inline-meta");
                    item.appendChild(rDiv);
                }
            }

            cb.onchange = async () => {
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId);
                if (idx !== -1) {
                    await this.plugin.toggleTask(idx);
                    if (cb.checked) {
                        titleSpan.classList.remove("dida-timeline-task-title");
                        titleSpan.classList.add("dida-timeline-task-completed");
                    } else {
                        titleSpan.classList.remove("dida-timeline-task-completed");
                        titleSpan.classList.add("dida-timeline-task-title");
                    }
                }
            };

            if (task.items && task.items.length > 0) {
                const activeCount = task.items.filter((i: any) => i.status === 1).length;
                const subSpan = item.createEl("span", { cls: "dida-subtask-count" });
                setTextWithIcon(subSpan, `${activeCount}/${task.items.length}`, "list-todo");
                subSpan.addClass("dida-task-count-base", "dida-task-count-sub");
                subSpan.title = this.plugin.t("timeline.checkItemsHint");
                subSpan.onclick = () => this.toggleTimelineTaskDetails(item, task, "check-items-tab");
            }

            const childTasks = this.plugin.settings.tasks.filter(t => t.parentId === task.didaId);
            if (task.didaId && childTasks.length > 0) {
                const completedChilds = childTasks.filter(t => t.status === 2).length;
                const childSpan = item.createEl("span", { cls: "dida-child-task-count" });
                childSpan.addClass("dida-task-count-base", "dida-task-count-child", "dida-child-task-count-static");
                this.renderChildCountBadge(childSpan, completedChilds, childTasks.length);
                childSpan.title = this.plugin.t("timeline.subtaskCount");
            }

            const dateSpan = item.createEl("span", { cls: "dida-task-due-date" });
            if (task.dueDate) {
                try {
                    const d = new Date(task.dueDate);
                    const m = d.getMonth() + 1;
                    const day = d.getDate();
                    dateSpan.textContent = `${m}/${day}`;
                    const now = new Date();
                    now.setHours(0, 0, 0, 0);
                    d.setHours(0, 0, 0, 0);
                    if (d < now) dateSpan.classList.add("overdue");
                    else if (d.getTime() === now.getTime()) dateSpan.classList.add("today");
                } catch (e) {
                    dateSpan.textContent = "";
                }
            } else {
                setIconElement(dateSpan, "calendar-x-2");
                dateSpan.classList.add("no-date");
            }
            dateSpan.addClass("dida-clickable-date");
            dateSpan.title = this.plugin.t("timeline.setDueDate");
            dateSpan.onclick = (e) => {
                e.stopPropagation();
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId);
                if (idx !== -1) {
                    const date = task.startDate || task.dueDate || this.selectedDate;
                    new DatePickerModal(this.app, date as any, async (d, allDay, endDate, repeatFlag) => {
                        await this.updateTimelineTaskSchedule(idx, d, allDay, endDate, repeatFlag);
                    }, e.currentTarget as HTMLElement, this.plugin, idx).open();
                }
            };

            const delBtn = item.createEl("button", { cls: "dida-task-delete" });
            setIconElement(delBtn, "x");
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (confirm(this.plugin.t("timeline.deleteConfirm", { title: task.title }))) {
                    const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId);
                    if (idx !== -1) {
                        await this.plugin.deleteTask(idx);
                        this.renderTimelineView();
                    }
                }
            };
        });
    }

    renderFloatingActionButton(container: HTMLElement) {
        const fab = container.createDiv("dida-timeline-fab");
        setIconElement(fab, "plus");
        fab.onclick = () => {
            this.showAddTaskModal(fab);
        };
    }

    showAddTaskModal(triggerElement: HTMLElement | null = null) {
        const projects = this.plugin.getAvailableProjectConfigs().map(project => ({ id: project.id, name: project.name }));
        new AddTaskModal(this.app, async (title, project, schedule) => {
            await this.plugin.addTask(title, project.name, project.id, true, null, schedule);
            this.renderTimelineView();
        }, {
            plugin: this.plugin,
            projects: projects.length > 0 ? projects : [{ id: "inbox", name: INBOX_PROJECT_NAME }],
            defaultProjectId: "inbox",
            defaultDate: this.selectedDate,
            triggerElement,
            scopeElement: this.windowElement
        }).open();
    }

    toggleTimelineTaskDetails(item: HTMLElement, task: DidaTask, tab: string = "task-tab") {
        const initialTab = tab === "check-items-tab" ? "check-items-tab" : "task-tab";
        document.querySelectorAll(".dida-task-details").forEach(el => {
            if (!item.contains(el)) el.remove();
        });

        const existing = item.querySelector(".dida-task-details");
        if (existing) {
            existing.remove();
            return;
        }

        const details = item.createDiv("dida-task-details");
        const taskIndex = resolveTaskIndex(this.plugin.settings.tasks, task, (task as any).originalIndex);
        const currentTask: any = taskIndex !== -1 ? this.plugin.settings.tasks[taskIndex] : null;

        if (currentTask) {
            currentTask.content = typeof currentTask.content === "string" ? currentTask.content : (currentTask.content || "");
            currentTask.desc = typeof currentTask.desc === "string" ? currentTask.desc : (currentTask.desc || "");
            currentTask.items = currentTask.items || [];

            const nav = details.createDiv("dida-task-tab-nav");
            const taskTabBtn = nav.createEl("button", { text: this.plugin.t("timeline.tabTask"), cls: initialTab === "task-tab" ? "dida-tab-btn active" : "dida-tab-btn" });
            const checkTabBtn = nav.createEl("button", { text: this.plugin.t("timeline.tabCheckItems"), cls: initialTab === "check-items-tab" ? "dida-tab-btn active" : "dida-tab-btn" });

            const contentArea = details.createDiv("dida-task-content-area");
            const taskTab = contentArea.createDiv(initialTab === "task-tab" ? "dida-tab-content active" : "dida-tab-content");
            taskTab.id = "task-tab";
            const titleRow = taskTab.createDiv("dida-task-detail-title");
            titleRow.addClass("dida-detail-title-row");
            titleRow.createEl("strong", { text: this.plugin.t("timeline.fieldTitle") });
            const titleInput = titleRow.createEl("input", { type: "text", value: currentTask.title, cls: "dida-task-title-input" });
            titleInput.addClass("dida-detail-title-input-grow");
            const contentRow = taskTab.createDiv("dida-task-detail-content");
            let contentField = "content";
            let contentValue = currentTask.content || "";
            if (currentTask.kind === "CHECKLIST") {
                contentField = "desc";
                contentValue = currentTask.desc || "";
                contentRow.createEl("strong", { text: this.plugin.t("timeline.fieldDesc") });
            } else {
                contentRow.createEl("strong", { text: this.plugin.t("timeline.fieldContent") });
            }
            const contentTextarea = contentRow.createEl("textarea", { cls: "dida-task-content-textarea" });
            contentTextarea.placeholder = this.plugin.t("timeline.contentPlaceholder");
            contentTextarea.value = contentValue;

            const checkTab = contentArea.createDiv(initialTab === "check-items-tab" ? "dida-tab-content active" : "dida-tab-content");
            checkTab.id = "check-items-tab";
            const checkList = checkTab.createDiv("dida-check-items-list");

            const renderCheckItems = () => {
                checkList.empty();
                if (currentTask.items && currentTask.items.length > 0) {
                    currentTask.items.forEach((item: any, idx: number) => {
                        const itemDiv = checkList.createDiv("dida-task-item dida-check-item");
                        const cb = itemDiv.createEl("input", { type: "checkbox", checked: item.status === 1 });
                        const input = itemDiv.createEl("input", {
                            type: "text",
                            value: item.title,
                            cls: item.status === 1 ? "dida-task-completed" : "dida-task-title-input",
                            placeholder: this.plugin.t("timeline.checkItemPlaceholder")
                        });
                        cb.onchange = () => {
                            item.status = cb.checked ? 1 : 0;
                            if (cb.checked) {
                                item.completedTime = new Date().toISOString();
                                input.classList.remove("dida-task-title-input");
                                input.classList.add("dida-task-completed");
                            } else {
                                item.completedTime = null;
                                input.classList.remove("dida-task-completed");
                                input.classList.add("dida-task-title-input");
                            }
                            currentTask.items[idx] = item;
                            this.plugin.saveSettings();
                            this.plugin.updateTaskInDidaList(currentTask);
                        };
                        input.onchange = () => {
                            item.title = input.value;
                            currentTask.items[idx] = item;
                            this.plugin.saveSettings();
                            this.plugin.updateTaskInDidaList(currentTask);
                        };
                        const delBtn = itemDiv.createEl("button", { cls: "dida-task-delete" });
                        setIconElement(delBtn, "x");
                        delBtn.onclick = (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            currentTask.items.splice(idx, 1);
                            this.plugin.saveSettings();
                            this.plugin.updateTaskInDidaList(currentTask);
                            renderCheckItems();
                        };
                    });
                }
            };
            renderCheckItems();

            const addCheckItemBtn = checkTab.createEl("button", { cls: "dida-project-add-task-btn" });
            setIconElement(addCheckItemBtn, "plus");
            addCheckItemBtn.addClass("dida-floating-add-btn");
            addCheckItemBtn.title = this.plugin.t("timeline.addCheckItem");
            addCheckItemBtn.onclick = () => {
                if (!currentTask.items) currentTask.items = [];
                currentTask.items.push({
                    id: Date.now().toString(),
                    title: "",
                    status: 0,
                    sortOrder: currentTask.items.length
                });
                this.plugin.saveSettings();
                this.plugin.updateTaskInDidaList(currentTask);
                renderCheckItems();
            };

            const saveChanges = () => {
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === currentTask.didaId || t.id === currentTask.id);
                if (idx !== -1) {
                    this.plugin.saveTaskDetails(idx, titleInput.value, contentTextarea.value, contentField);
                    this.renderTimelineView();
                    this.plugin.refreshTaskView();
                }
            };
            titleInput.onchange = saveChanges;
            contentTextarea.onchange = saveChanges;

            taskTabBtn.onclick = () => {
                taskTabBtn.classList.add("active");
                checkTabBtn.classList.remove("active");
                taskTab.classList.add("active");
                checkTab.classList.remove("active");
            };
            checkTabBtn.onclick = () => {
                taskTabBtn.classList.remove("active");
                checkTabBtn.classList.add("active");
                taskTab.classList.remove("active");
                checkTab.classList.add("active");
            };
        }
    }

    async updateTimelineTaskSchedule(index: number, date: Date | null, isAllDay: boolean, endDate?: Date, repeatFlag?: string | null) {
        const taskView = this.plugin.getTaskViewSafely();
        if (taskView) {
            await taskView.updateTaskSchedule(index, date, isAllDay, endDate, repeatFlag);
            this.renderTimelineView();
            return;
        }
        const task = this.plugin.settings.tasks[index];
        if (!task) return;
        if (!date) {
            task.startDate = null as any;
            task.dueDate = null as any;
            task.isAllDay = false;
            task.repeatFlag = undefined;
        } else {
            const start = new Date(date);
            const due = new Date(endDate || date);
            if (isAllDay) {
                start.setHours(0, 0, 0, 0);
                due.setHours(0, 0, 0, 0);
            } else if (due.getTime() <= start.getTime()) {
                due.setTime(start.getTime() + 15 * 60 * 1000);
            }
            task.startDate = this.plugin.formatDidaDateTime(start);
            task.dueDate = this.plugin.formatDidaDateTime(due);
            task.isAllDay = isAllDay;
            task.repeatFlag = repeatFlag || undefined;
        }
        task.updatedAt = new Date().toISOString();
        await this.plugin.saveSettings();
        this.renderTimelineView();
        this.plugin.refreshTaskView();
        if (this.plugin.settings.accessToken && task.didaId) {
            setTimeout(async () => {
                try { await this.plugin.updateTaskInDidaList(task); } catch (e) { }
            }, 0);
        }
    }
}
