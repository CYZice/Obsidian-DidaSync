import { App } from 'obsidian';
import DidaSyncPlugin from '../main';
import { DidaTask } from '../types';
import { debounce, translateRepeatFlag } from '../utils';
import { TASK_VIEW_TYPE } from '../views/TaskView';
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
        title.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-check-icon lucide-calendar-check"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/></svg> 时间线日历视图';

        const closeBtn = header.createEl("button", {
            cls: "dida-timeline-custom-window-close"
        });
        closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
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
            text: "‹",
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

        nav.createDiv("dida-timeline-month-display").innerHTML = `${this.displayYear}年${this.displayMonth + 1}月`;

        nav.createEl("button", {
            text: "›",
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
            text: this.isCalendarExpanded ? "收起" : "展开",
            cls: "dida-timeline-expand-btn"
        }).onclick = () => {
            this.isCalendarExpanded = !this.isCalendarExpanded;
            this.renderTimelineView();
        };

        const weekHeader = selector.createDiv("dida-timeline-week-header");
        ["日", "一", "二", "三", "四", "五", "六"].forEach(d => {
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
            countDiv.style.cssText = `
                display: flex;
                justify-content: center;
                align-items: center;
                gap: 2px;
                font-size: 8px;
                color: var(--text-muted);
                line-height: 1;
            `;

            const maxDots = 10;
            if (totalCount > maxDots) {
                countDiv.createEl("span", {
                    text: "+" + totalCount,
                    cls: "dida-timeline-task-more"
                }).style.cssText = `
                    font-size: 7px;
                    color: var(--text-muted);
                    line-height: 1;
                    font-weight: bold;
                `;
            } else {
                const rows = Math.ceil(Math.min(totalCount, maxDots) / 5);
                let p = Math.min(pendingCount, maxDots);
                let d = Math.min(doneCount, Math.max(0, maxDots - p));

                for (let r = 0; r < rows; r++) {
                    const rowDiv = countDiv.createDiv("dida-timeline-task-dots-row");
                    rowDiv.style.cssText = `
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        gap: 1px;
                        line-height: 1;
                    `;

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
                        dot.style.cssText = `
                            font-size: 10px;
                            line-height: 1;
                            font-weight: bold;
                        `;
                        if (isDone) dot.title = "已完成任务";
                    }
                }
            }
            countDiv.title = totalCount + " 个任务";
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
            if (t.parentId) return false; // Only top level?
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
            list.createDiv("dida-timeline-empty-state").innerHTML = "<p>今天没有任务</p>";
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
            elementContainer.createDiv("dida-timeline-time-label").textContent = "全天";

            const cb = elementContainer.createEl("input", { type: "checkbox" });
            cb.checked = task.status === 2;

            const titleSpan = elementContainer.createEl("span", {
                cls: task.status === 2 ? "dida-timeline-task-completed dida-task-title-clickable" : "dida-timeline-task-title dida-task-title-clickable"
            });
            this.renderTimelineTaskTitleContent(titleSpan, task.title || "无标题任务");

            titleSpan.onclick = () => this.toggleTimelineTaskDetails(item, task);

            if (task.repeatFlag && task.repeatFlag.trim() !== "") {
                const repeatText = translateRepeatFlag(task.repeatFlag);
                if (repeatText) {
                    const rDiv = document.createElement("div");
                    rDiv.className = "dida-task-repeat-rule";
                    rDiv.innerHTML = repeatText;
                    rDiv.style.fontSize = "8px";
                    rDiv.style.color = "#0066cc";
                    rDiv.style.marginTop = "2px";
                    rDiv.style.marginLeft = "20px";
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
                subSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" id="item-text" fill="#4c4f69">
  <path d="M30.06666612625122,7.625000095367431Q30.06666612625122,7.221142095367432,30.35223712625122,6.935571095367432Q30.637808126251223,6.650000095367432,31.041666126251222,6.650000095367432L40.95836612625122,6.650000095367432Q41.362166126251225,6.650000095367432,41.64776612625122,6.935571095367432Q41.93336612625122,7.221140095367431,41.93336612625122,7.625000095367431Q41.93336612625122,8.028860095367431,41.64776612625122,8.314430095367431Q41.362166126251225,8.600000095367431,40.95836612625122,8.600000095367431L31.041666126251222,8.600000095367431Q30.637808126251223,8.600000095367431,30.35223712625122,8.314430095367431Q30.06666612625122,8.028860095367431,30.06666612625122,7.625000095367431ZM32.98332612625122,12.000000095367431Q32.98332612625122,11.596140095367431,33.26889612625122,11.310570095367432Q33.554476126251224,11.025000095367432,33.95832612625122,11.025000095367432L40.95836612625122,11.025000095367432Q41.362166126251225,11.025000095367432,41.64776612625122,11.310570095367432Q41.93336612625122,11.596140095367431,41.93336612625122,12.000000095367431Q41.93336612625122,12.403860095367431,41.64776612625122,12.689430095367431Q41.362166126251225,12.975000095367431,40.95836612625122,12.975000095367431L37.45832612625122,12.975000095367431L33.95832612625122,12.975000095367431Q33.554476126251224,12.975000095367431,33.26889612625122,12.689430095367431Q32.98332612625122,12.403860095367431,32.98332612625122,12.000000095367431ZM32.98332612625122,16.375000095367433Q32.98332612625122,15.971140095367431,33.26889612625122,15.685570095367432Q33.55446612625122,15.400000095367432,33.95832612625122,15.400000095367432L40.95836612625122,15.400000095367432Q41.362166126251225,15.400000095367432,41.64776612625122,15.685570095367432Q41.93336612625122,15.971140095367431,41.93336612625122,16.375000095367433Q41.93336612625122,16.778900095367433,41.64776612625122,17.064400095367432Q41.362166126251225,17.35000009536743,40.95836612625122,17.35000009536743L33.95832612625122,17.35000009536743Q33.55446612625122,17.35000009536743,33.26889612625122,17.064400095367432Q32.98332612625122,16.778900095367433,32.98332612625122,16.375000095367433Z" fill-rule="evenodd"></path>
  <path d="M46.5,18.5L46.5,5.5Q46.5,3.84314,45.3284,2.671573Q44.1569,1.5,42.5,1.5L29.5,1.5Q27.84315,1.5,26.671573,2.671573Q25.5,3.84315,25.5,5.5L25.5,18.5Q25.5,20.1569,26.671573,21.3284Q27.84314,22.5,29.5,22.5L42.5,22.5Q44.1569,22.5,45.3284,21.3284Q46.5,20.1569,46.5,18.5ZM44.5,5.5L44.5,18.5Q44.5,19.3284,43.9142,19.9142Q43.3284,20.5,42.5,20.5L29.5,20.5Q28.67157,20.5,28.08579,19.9142Q27.5,19.3284,27.5,18.5L27.5,5.5Q27.5,4.67157,28.08579,4.08579Q28.67157,3.5,29.5,3.5L42.5,3.5Q43.3284,3.5,43.9142,4.08579Q44.5,4.67157,44.5,5.5Z" fill-rule="evenodd" transform="matrix(-1 0 0 1 48 0)"></path>
</svg>${activeCount}/${task.items.length}`;
                subSpan.style.fontSize = "0.8em";
                subSpan.style.color = "#666";
                subSpan.style.marginLeft = "2px";
                subSpan.style.display = "flex";
                subSpan.style.alignItems = "center";
                subSpan.style.gap = "2px";
                subSpan.style.cursor = "pointer";
                subSpan.title = "点击查看检查项";
                subSpan.onclick = () => this.toggleTimelineTaskDetails(item, task, "check-items-tab");
            }

            const childTasks = this.plugin.settings.tasks.filter(t => t.parentId === task.didaId);
            if (task.didaId && childTasks.length > 0) {
                const completedChilds = childTasks.filter(t => t.status === 2).length;
                const childSpan = item.createEl("span", { cls: "dida-child-task-count" });
                childSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 12 12" id="descendant-task-small" fill="#4c4f69">
  <path d="M1.2500016689300537,1.491542L1.2500016689300537,8.31342C1.2500016689300537,9.3755,2.1029426689300537,10.25,3.1650316689300535,10.25L6.995881668930053,10.25C7.272021668930054,10.25,7.500001668930054,10.02614,7.500001668930054,9.75C7.500001668930054,9.47386,7.2761416689300535,9.25,7.000001668930054,9.25L3.204551668930054,9.25C2.677361668930054,9.25,2.2500016689300537,8.82264,2.2500016689300537,8.295449999999999L2.2500016689300537,4.75L7.000001668930054,4.75C7.2761416689300535,4.75,7.500001668930054,4.52614,7.500001668930054,4.25C7.500001668930054,3.97386,7.2761416689300535,3.75,7.000001668930054,3.75L2.2500016689300537,3.75L2.2500016689300537,1.5C2.2500016689300537,1.223858,2.026143668930054,1,1.7500016689300537,1C1.4738596689300536,1,1.2500016689300537,1.2154,1.2500016689300537,1.491542ZM10.750001668930054,4.25Q10.750001668930054,4.34849,10.730781668930053,4.44509Q10.711571668930054,4.54169,10.673881668930054,4.632680000000001Q10.636191668930053,4.72368,10.581471668930053,4.8055699999999995Q10.526751668930054,4.88746,10.457111668930054,4.95711Q10.387461668930055,5.02675,10.305571668930053,5.08147Q10.223681668930054,5.13619,10.132681668930054,5.17388Q10.041691668930053,5.21157,9.945091668930054,5.23078Q9.848491668930054,5.25,9.750001668930054,5.25Q9.651511668930054,5.25,9.554911668930053,5.23078Q9.458311668930055,5.21157,9.367321668930053,5.17388Q9.276321668930054,5.13619,9.194431668930054,5.08147Q9.112541668930053,5.02675,9.042891668930054,4.95711Q8.973251668930054,4.88746,8.918531668930054,4.8055699999999995Q8.863811668930055,4.72368,8.826121668930053,4.632680000000001Q8.788431668930054,4.54169,8.769211668930055,4.44509Q8.750001668930054,4.34849,8.750001668930054,4.25Q8.750001668930054,4.15151,8.769211668930055,4.05491Q8.788431668930054,3.95831,8.826121668930053,3.86732Q8.863811668930055,3.77632,8.918531668930054,3.69443Q8.973251668930054,3.61254,9.042891668930054,3.54289Q9.112541668930053,3.47325,9.194431668930054,3.41853Q9.276321668930054,3.36381,9.367321668930053,3.32612Q9.458311668930055,3.28843,9.554911668930053,3.26922Q9.651511668930054,3.25,9.750001668930054,3.25Q9.848491668930054,3.25,9.945091668930054,3.26922Q10.041691668930053,3.28843,10.132681668930054,3.32612Q10.223681668930054,3.36381,10.305571668930053,3.41853Q10.387461668930055,3.47325,10.457111668930054,3.54289Q10.526751668930054,3.61254,10.581471668930053,3.69443Q10.636191668930053,3.77632,10.673881668930054,3.86732Q10.711571668930054,3.95831,10.730781668930053,4.05491Q10.750001668930054,4.15151,10.750001668930054,4.25Z" fill-rule="evenodd"></path>
</svg>${completedChilds}/${childTasks.length}`;
                childSpan.style.fontSize = "0.8em";
                childSpan.style.color = "#0066cc";
                childSpan.style.marginLeft = "2px";
                childSpan.style.display = "flex";
                childSpan.style.alignItems = "center";
                childSpan.style.gap = "2px";
                childSpan.style.cursor = "pointer";
                childSpan.title = "点击查看子任务";
                childSpan.onclick = () => this.toggleTimelineTaskDetails(item, task, "subtasks-tab");
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
                dateSpan.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#da1b1b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-x2-icon lucide-calendar-x-2"><path d="M8 2v4"/><path d="M16 2v4"/><path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"/><path d="M3 10h18"/><path d="m17 22 5-5"/><path d="m17 17 5 5"/></svg>';
                dateSpan.classList.add("no-date");
            }

            dateSpan.style.cursor = "pointer";
            dateSpan.title = "点击设置到期日期";
            dateSpan.onclick = (e) => {
                e.stopPropagation();
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId || t.id === task.id);
                if (idx !== -1) {
                    const d = task.startDate || task.dueDate || this.selectedDate;
                    new DatePickerModal(this.app, new Date(d), async (date, isAllDay, endDate) => {
                        await this.updateTimelineTaskDueDate(idx, date, isAllDay);
                    }, e.currentTarget as HTMLElement, this.plugin, idx).open();
                }
            };

            const delBtn = item.createEl("button", { cls: "dida-task-delete" });
            delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (confirm(`确定要删除任务"${task.title}"吗？`)) {
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
            const timeStr = new Date(task.startDate || task.dueDate!).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false
            });
            timeLabel.textContent = timeStr;

            const cb = elementContainer.createEl("input", { type: "checkbox" });
            cb.checked = task.status === 2;
            const titleSpan = elementContainer.createEl("span", {
                cls: task.status === 2 ? "dida-timeline-task-completed dida-task-title-clickable" : "dida-timeline-task-title dida-task-title-clickable"
            });
            this.renderTimelineTaskTitleContent(titleSpan, task.title || "无标题任务");
            titleSpan.onclick = () => this.toggleTimelineTaskDetails(item, task);

            if (task.repeatFlag && task.repeatFlag.trim() !== "") {
                const repeatText = translateRepeatFlag(task.repeatFlag);
                if (repeatText) {
                    const rDiv = document.createElement("div");
                    rDiv.className = "dida-task-repeat-rule";
                    rDiv.innerHTML = repeatText;
                    rDiv.style.fontSize = "8px";
                    rDiv.style.color = "#0066cc";
                    rDiv.style.marginTop = "2px";
                    rDiv.style.marginLeft = "20px";
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
                subSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" id="item-text" fill="#4c4f69">
  <path d="M30.06666612625122,7.625000095367431Q30.06666612625122,7.221142095367432,30.35223712625122,6.935571095367432Q30.637808126251223,6.650000095367432,31.041666126251222,6.650000095367432L40.95836612625122,6.650000095367432Q41.362166126251225,6.650000095367432,41.64776612625122,6.935571095367432Q41.93336612625122,7.221140095367431,41.93336612625122,7.625000095367431Q41.93336612625122,8.028860095367431,41.64776612625122,8.314430095367431Q41.362166126251225,8.600000095367431,40.95836612625122,8.600000095367431L31.041666126251222,8.600000095367431Q30.637808126251223,8.600000095367431,30.35223712625122,8.314430095367431Q30.06666612625122,8.028860095367431,30.06666612625122,7.625000095367431ZM32.98332612625122,12.000000095367431Q32.98332612625122,11.596140095367431,33.26889612625122,11.310570095367432Q33.554476126251224,11.025000095367432,33.95832612625122,11.025000095367432L40.95836612625122,11.025000095367432Q41.362166126251225,11.025000095367432,41.64776612625122,11.310570095367432Q41.93336612625122,11.596140095367431,41.93336612625122,12.000000095367431Q41.93336612625122,12.403860095367431,41.64776612625122,12.689430095367431Q41.362166126251225,12.975000095367431,40.95836612625122,12.975000095367431L37.45832612625122,12.975000095367431L33.95832612625122,12.975000095367431Q33.554476126251224,12.975000095367431,33.26889612625122,12.689430095367431Q32.98332612625122,12.403860095367431,32.98332612625122,12.000000095367431ZM32.98332612625122,16.375000095367433Q32.98332612625122,15.971140095367431,33.26889612625122,15.685570095367432Q33.55446612625122,15.400000095367432,33.95832612625122,15.400000095367432L40.95836612625122,15.400000095367432Q41.362166126251225,15.400000095367432,41.64776612625122,15.685570095367432Q41.93336612625122,15.971140095367431,41.93336612625122,16.375000095367433Q41.93336612625122,16.778900095367433,41.64776612625122,17.064400095367432Q41.362166126251225,17.35000009536743,40.95836612625122,17.35000009536743L33.95832612625122,17.35000009536743Q33.55446612625122,17.35000009536743,33.26889612625122,17.064400095367432Q32.98332612625122,16.778900095367433,32.98332612625122,16.375000095367433Z" fill-rule="evenodd"></path>
  <path d="M46.5,18.5L46.5,5.5Q46.5,3.84314,45.3284,2.671573Q44.1569,1.5,42.5,1.5L29.5,1.5Q27.84315,1.5,26.671573,2.671573Q25.5,3.84315,25.5,5.5L25.5,18.5Q25.5,20.1569,26.671573,21.3284Q27.84314,22.5,29.5,22.5L42.5,22.5Q44.1569,22.5,45.3284,21.3284Q46.5,20.1569,46.5,18.5ZM44.5,5.5L44.5,18.5Q44.5,19.3284,43.9142,19.9142Q43.3284,20.5,42.5,20.5L29.5,20.5Q28.67157,20.5,28.08579,19.9142Q27.5,19.3284,27.5,18.5L27.5,5.5Q27.5,4.67157,28.08579,4.08579Q28.67157,3.5,29.5,3.5L42.5,3.5Q43.3284,3.5,43.9142,4.08579Q44.5,4.67157,44.5,5.5Z" fill-rule="evenodd" transform="matrix(-1 0 0 1 48 0)"></path>
</svg>${activeCount}/${task.items.length}`;
                subSpan.style.fontSize = "0.8em";
                subSpan.style.color = "#666";
                subSpan.style.marginLeft = "2px";
                subSpan.style.display = "flex";
                subSpan.style.alignItems = "center";
                subSpan.style.gap = "2px";
                subSpan.style.cursor = "pointer";
                subSpan.title = "点击查看检查项";
                subSpan.onclick = () => this.toggleTimelineTaskDetails(item, task, "check-items-tab");
            }

            const childTasks = this.plugin.settings.tasks.filter(t => t.parentId === task.didaId);
            if (task.didaId && childTasks.length > 0) {
                const completedChilds = childTasks.filter(t => t.status === 2).length;
                const childSpan = item.createEl("span", { cls: "dida-child-task-count" });
                childSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 12 12" id="descendant-task-small" fill="#4c4f69">
  <path d="M1.2500016689300537,1.491542L1.2500016689300537,8.31342C1.2500016689300537,9.3755,2.1029426689300537,10.25,3.1650316689300535,10.25L6.995881668930053,10.25C7.272021668930054,10.25,7.500001668930054,10.02614,7.500001668930054,9.75C7.500001668930054,9.47386,7.2761416689300535,9.25,7.000001668930054,9.25L3.204551668930054,9.25C2.677361668930054,9.25,2.2500016689300537,8.82264,2.2500016689300537,8.295449999999999L2.2500016689300537,4.75L7.000001668930054,4.75C7.2761416689300535,4.75,7.500001668930054,4.52614,7.500001668930054,4.25C7.500001668930054,3.97386,7.2761416689300535,3.75,7.000001668930054,3.75L2.2500016689300537,3.75L2.2500016689300537,1.5C2.2500016689300537,1.223858,2.026143668930054,1,1.7500016689300537,1C1.4738596689300536,1,1.2500016689300537,1.2154,1.2500016689300537,1.491542ZM10.750001668930054,4.25Q10.750001668930054,4.34849,10.730781668930053,4.44509Q10.711571668930054,4.54169,10.673881668930054,4.632680000000001Q10.636191668930053,4.72368,10.581471668930053,4.8055699999999995Q10.526751668930054,4.88746,10.457111668930054,4.95711Q10.387461668930055,5.02675,10.305571668930053,5.08147Q10.223681668930054,5.13619,10.132681668930054,5.17388Q10.041691668930053,5.21157,9.945091668930054,5.23078Q9.848491668930054,5.25,9.750001668930054,5.25Q9.651511668930054,5.25,9.554911668930053,5.23078Q9.458311668930055,5.21157,9.367321668930053,5.17388Q9.276321668930054,5.13619,9.194431668930054,5.08147Q9.112541668930053,5.02675,9.042891668930054,4.95711Q8.973251668930054,4.88746,8.918531668930054,4.8055699999999995Q8.863811668930055,4.72368,8.826121668930053,4.632680000000001Q8.788431668930054,4.54169,8.769211668930055,4.44509Q8.750001668930054,4.34849,8.750001668930054,4.25Q8.750001668930054,4.15151,8.769211668930055,4.05491Q8.788431668930054,3.95831,8.826121668930053,3.86732Q8.863811668930055,3.77632,8.918531668930054,3.69443Q8.973251668930054,3.61254,9.042891668930054,3.54289Q9.112541668930053,3.47325,9.194431668930054,3.41853Q9.276321668930054,3.36381,9.367321668930053,3.32612Q9.458311668930055,3.28843,9.554911668930053,3.26922Q9.651511668930054,3.25,9.750001668930054,3.25Q9.848491668930054,3.25,9.945091668930054,3.26922Q10.041691668930053,3.28843,10.132681668930054,3.32612Q10.223681668930054,3.36381,10.305571668930053,3.41853Q10.387461668930055,3.47325,10.457111668930054,3.54289Q10.526751668930054,3.61254,10.581471668930053,3.69443Q10.636191668930053,3.77632,10.673881668930054,3.86732Q10.711571668930054,3.95831,10.730781668930053,4.05491Q10.750001668930054,4.15151,10.750001668930054,4.25Z" fill-rule="evenodd"></path>
</svg>${completedChilds}/${childTasks.length}`;
                childSpan.style.fontSize = "0.8em";
                childSpan.style.color = "#0066cc";
                childSpan.style.marginLeft = "2px";
                childSpan.style.display = "flex";
                childSpan.style.alignItems = "center";
                childSpan.style.gap = "2px";
                childSpan.style.cursor = "pointer";
                childSpan.title = "点击查看子任务";
                childSpan.onclick = () => this.toggleTimelineTaskDetails(item, task, "subtasks-tab");
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
                dateSpan.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#da1b1b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-x2-icon lucide-calendar-x-2"><path d="M8 2v4"/><path d="M16 2v4"/><path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"/><path d="M3 10h18"/><path d="m17 22 5-5"/><path d="m17 17 5 5"/></svg>';
                dateSpan.classList.add("no-date");
            }
            dateSpan.style.cursor = "pointer";
            dateSpan.title = "点击设置到期日期";
            dateSpan.onclick = (e) => {
                e.stopPropagation();
                const idx = this.plugin.settings.tasks.findIndex(t => t.didaId === task.didaId);
                if (idx !== -1) {
                    const date = task.startDate || task.dueDate || this.selectedDate;
                    new DatePickerModal(this.app, date as any, async (d, allDay, endDate) => {
                        if (d) {
                            const leaves = this.plugin.app.workspace.getLeavesOfType(TASK_VIEW_TYPE);
                            if (leaves.length > 0 && (leaves[0].view as any).updateTaskStartDate) {
                                await (leaves[0].view as any).updateTaskStartDate(idx, d, allDay);
                                if (endDate && !allDay && (leaves[0].view as any).updateTaskDueDate) {
                                    await (leaves[0].view as any).updateTaskDueDate(idx, endDate, false);
                                }
                            }
                            this.renderTimelineView();
                            this.plugin.refreshTaskView();
                        }
                    }, e.currentTarget as HTMLElement, this.plugin, idx).open();
                }
            };

            const delBtn = item.createEl("button", { cls: "dida-task-delete" });
            delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
            delBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (confirm(`确定要删除任务"${task.title}"吗？`)) {
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
        fab.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus-icon lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
        fab.onclick = () => {
            this.showAddTaskModal();
        };
    }

    showAddTaskModal() {
        new AddTaskModal(this.app, async (title) => {
            const newTask: DidaTask = {
                id: Date.now().toString(),
                title: title,
                completed: false,
                status: 0,
                dueDate: this.selectedDate.toISOString(),
                projectName: "收集箱",
                projectId: "inbox",
                content: "",
                desc: "",
                items: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                kind: "TEXT",
                priority: 0,
                sortOrder: 0,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                isFloating: false,
                isAllDay: true, // Default to all day if added from timeline fab? Source: hasTime: !1
                didaId: null
            };
            this.plugin.settings.tasks = this.plugin.settings.tasks || [];
            this.plugin.settings.tasks.push(newTask);
            await this.plugin.saveSettings();
            this.renderTimelineView();

            if (this.plugin.settings.accessToken) {
                this.plugin.createTaskInDidaList(newTask).catch(console.error);
            }
        }, "收集箱").open();
    }

    toggleTimelineTaskDetails(item: HTMLElement, task: DidaTask, tab: string = "task-tab") {
        document.querySelectorAll(".dida-task-details").forEach(el => {
            if (!item.contains(el)) el.remove();
        });

        const existing = item.querySelector(".dida-task-details");
        if (existing) {
            existing.remove();
            return;
        }

        const details = item.createDiv("dida-task-details");
        let currentTask: any = null;
        if (task.originalIndex !== undefined && this.plugin.settings.tasks[task.originalIndex]) {
            currentTask = this.plugin.settings.tasks[task.originalIndex];
        } else if (task.didaId) {
            currentTask = this.plugin.settings.tasks.find(t => t.didaId === task.didaId);
        } else if (task.id) {
            currentTask = this.plugin.settings.tasks.find(t => t.id === task.id);
        }

        if (currentTask) {
            currentTask.content = typeof currentTask.content === "string" ? currentTask.content : (currentTask.content || "");
            currentTask.desc = typeof currentTask.desc === "string" ? currentTask.desc : (currentTask.desc || "");
            currentTask.items = currentTask.items || [];

            const nav = details.createDiv("dida-task-tab-nav");
            const taskTabBtn = nav.createEl("button", { text: "任务", cls: tab === "task-tab" ? "dida-tab-btn active" : "dida-tab-btn" });
            const checkTabBtn = nav.createEl("button", { text: "检查项", cls: tab === "check-items-tab" ? "dida-tab-btn active" : "dida-tab-btn" });
            const subtaskTabBtn = nav.createEl("button", { text: "子任务", cls: tab === "subtasks-tab" ? "dida-tab-btn active" : "dida-tab-btn" });

            const contentArea = details.createDiv("dida-task-content-area");
            const taskTab = contentArea.createDiv(tab === "task-tab" ? "dida-tab-content active" : "dida-tab-content");
            taskTab.id = "task-tab";
            const titleRow = taskTab.createDiv("dida-task-detail-title");
            titleRow.style.display = "flex";
            titleRow.style.alignItems = "center";
            titleRow.createEl("strong", { text: "标题：" });
            const titleInput = titleRow.createEl("input", { type: "text", value: currentTask.title, cls: "dida-task-title-input" });
            titleInput.style.flex = "1";
            const contentRow = taskTab.createDiv("dida-task-detail-content");
            let contentField = "content";
            let contentValue = currentTask.content || "";
            if (currentTask.kind === "CHECKLIST") {
                contentField = "desc";
                contentValue = currentTask.desc || "";
                contentRow.createEl("strong", { text: "描述内容：" });
            } else {
                contentRow.createEl("strong", { text: "内容：" });
            }
            const contentTextarea = contentRow.createEl("textarea", { cls: "dida-task-content-textarea" });
            contentTextarea.placeholder = "内容...";
            contentTextarea.value = contentValue;

            const checkTab = contentArea.createDiv(tab === "check-items-tab" ? "dida-tab-content active" : "dida-tab-content");
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
                            placeholder: "检查项标题"
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
                        delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
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
            addCheckItemBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus-icon lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
            addCheckItemBtn.style.position = "absolute";
            addCheckItemBtn.style.top = "0";
            addCheckItemBtn.style.right = "0";
            addCheckItemBtn.title = "添加检查项";
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

            const subtaskTab = contentArea.createDiv(tab === "subtasks-tab" ? "dida-tab-content active" : "dida-tab-content");
            subtaskTab.id = "subtasks-tab";

            const refreshSubtaskArea = () => {
                subtaskTab.empty();
                const childTasks = this.plugin.settings.tasks.filter(t => t.parentId === (currentTask.didaId || currentTask.id));
                const incomplete = childTasks.filter(t => t.status !== 2);
                const complete = childTasks.filter(t => t.status === 2);
                [...incomplete, ...complete].forEach(sub => {
                    const itemDiv = subtaskTab.createDiv("dida-task-item dida-subtask-item");
                    const cb = itemDiv.createEl("input", { type: "checkbox", checked: sub.status === 2 });
                    const input = itemDiv.createEl("input", {
                        type: "text",
                        value: sub.title,
                        cls: sub.status === 2 ? "dida-task-completed" : "dida-task-title-input",
                        placeholder: "子任务标题"
                    });
                    cb.onchange = async () => {
                        const idx = this.plugin.settings.tasks.findIndex(t => t.id === sub.id);
                        if (idx !== -1) {
                            await this.plugin.toggleTask(idx);
                            refreshSubtaskArea();
                        }
                    };
                    input.onchange = async () => {
                        const idx = this.plugin.settings.tasks.findIndex(t => t.id === sub.id);
                        if (idx !== -1) {
                            const t = this.plugin.settings.tasks[idx];
                            t.title = input.value;
                            t.updatedAt = new Date().toISOString();
                            await this.plugin.saveSettings();
                            if (this.plugin.settings.accessToken && t.didaId) this.plugin.updateTaskInDidaList(t);
                        }
                    };
                    const delBtn = itemDiv.createEl("button", { cls: "dida-task-delete" });
                    delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
                    delBtn.onclick = async (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const idx = this.plugin.settings.tasks.findIndex(t => t.id === sub.id);
                        if (idx !== -1) {
                            await this.plugin.deleteTask(idx);
                            refreshSubtaskArea();
                        }
                    };
                });
                const addSubBtn = subtaskTab.createEl("button", { cls: "dida-project-add-task-btn" });
                addSubBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus-icon lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
                addSubBtn.style.position = "absolute";
                addSubBtn.style.top = "0";
                addSubBtn.style.right = "0";
                addSubBtn.title = "添加子任务";
                addSubBtn.onclick = async () => {
                    const newSub: DidaTask = {
                        id: Date.now().toString(),
                        title: "新子任务",
                        content: "",
                        desc: "",
                        status: 0,
                        didaId: null,
                        projectId: currentTask.projectId,
                        projectName: currentTask.projectName,
                        parentId: currentTask.didaId || currentTask.id,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        items: [],
                        kind: "TEXT",
                        priority: 0,
                        sortOrder: 0,
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                        isFloating: false,
                        isAllDay: false
                    } as any;
                    this.plugin.settings.tasks.push(newSub);
                    await this.plugin.saveSettings();
                    if (this.plugin.settings.accessToken) {
                        try { await this.plugin.createTaskInDidaList(newSub); } catch (e) { }
                    }
                    refreshSubtaskArea();
                };
            };
            refreshSubtaskArea();

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
                subtaskTabBtn.classList.remove("active");
                taskTab.classList.add("active");
                checkTab.classList.remove("active");
                subtaskTab.classList.remove("active");
            };
            checkTabBtn.onclick = () => {
                taskTabBtn.classList.remove("active");
                checkTabBtn.classList.add("active");
                subtaskTabBtn.classList.remove("active");
                taskTab.classList.remove("active");
                checkTab.classList.add("active");
                subtaskTab.classList.remove("active");
            };
            subtaskTabBtn.onclick = () => {
                taskTabBtn.classList.remove("active");
                checkTabBtn.classList.remove("active");
                subtaskTabBtn.classList.add("active");
                taskTab.classList.remove("active");
                checkTab.classList.remove("active");
                subtaskTab.classList.add("active");
            };
        }
    }

    async updateTimelineTaskDueDate(index: number, date: Date | null, isAllDay: boolean) {
        const task = this.plugin.settings.tasks[index];
        if (task) {
            let newDateStr: string | null = null;
            if (date) {
                if (isAllDay) {
                    const y = date.getFullYear();
                    const m = String(date.getMonth() + 1).padStart(2, "0");
                    const d = String(date.getDate()).padStart(2, "0");
                    const h = String(date.getHours()).padStart(2, "0");
                    const min = String(date.getMinutes()).padStart(2, "0");
                    const s = String(date.getSeconds()).padStart(2, "0");
                    const offset = date.getTimezoneOffset();
                    const oh = Math.abs(Math.floor(offset / 60));
                    const om = Math.abs(offset % 60);
                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                    newDateStr = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                } else {
                    const y = date.getFullYear();
                    const m = String(date.getMonth() + 1).padStart(2, "0");
                    const d = String(date.getDate()).padStart(2, "0");
                    const h = String(date.getHours()).padStart(2, "0");
                    const min = String(date.getMinutes()).padStart(2, "0");
                    const s = String(date.getSeconds()).padStart(2, "0");
                    const offset = date.getTimezoneOffset();
                    const oh = Math.abs(Math.floor(offset / 60));
                    const om = Math.abs(offset % 60);
                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                    newDateStr = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                }
            }
            task.dueDate = newDateStr;
            task.isAllDay = isAllDay;
            task.updatedAt = new Date().toISOString();
            await this.plugin.saveSettings();
            if (this.plugin.settings.accessToken && task.didaId) {
                setTimeout(async () => {
                    try { await this.plugin.updateTaskInDidaList(task); } catch (e) { }
                }, 0);
            }
        }
    }
}
