import { App } from "obsidian";
import {
    clearTaskSchedule,
    createTaskScheduleState,
    setTaskScheduleEndMinutes,
    setTaskScheduleStartMinutes,
    TASK_SCHEDULE_STEP_MINUTES,
    TaskScheduleState,
    TaskScheduleStateOptions,
    TaskScheduleValue,
    taskScheduleStateToValue
} from "../taskSchedule";
import { CompactRepeatSettings } from "./CompactRepeatSettings";

export interface TaskSchedulePickerOptions extends TaskScheduleStateOptions {
    dateOnly?: boolean;
}

export interface TaskScheduleActions {
    primaryLabel: string;
    onSubmit: (value: TaskScheduleValue) => void | boolean | Promise<void | boolean>;
    onCancel: () => void;
}

export class ScopedPopup {
    static activePopup: ScopedPopup | null = null;
    triggerElement: HTMLElement | null;
    scopeElement: HTMLElement | null;
    overlay: HTMLElement | null = null;
    container: HTMLElement | null = null;
    escapeHandler: ((event: KeyboardEvent) => void) | null = null;
    repositionHandler: (() => void) | null = null;
    outsidePointerHandler: ((event: PointerEvent) => void) | null = null;
    windowBlurHandler: (() => void) | null = null;
    visibilityHandler: (() => void) | null = null;
    extraClass: string;
    withOverlay: boolean;

    constructor(triggerElement: HTMLElement | null, scopeElement: HTMLElement | null = null, extraClass: string = "", withOverlay: boolean = true) {
        this.triggerElement = triggerElement;
        this.scopeElement = scopeElement;
        this.extraClass = extraClass;
        this.withOverlay = withOverlay;
    }

    open(render: (container: HTMLElement) => void): void {
        ScopedPopup.activePopup?.close();
        ScopedPopup.activePopup = this;
        if (this.withOverlay) this.overlay = document.body.createDiv("dida-calendar-overlay dida-schedule-popup-layer");
        this.container = document.body.createDiv(`dida-calendar-popup dida-schedule-popup-layer ${this.extraClass}`.trim());
        try {
            render(this.container);
            this.position();
            if (this.overlay) this.overlay.onclick = () => this.close();
            this.container.onclick = event => event.stopPropagation();
            this.escapeHandler = event => {
                if (event.key === "Escape") this.close();
            };
            this.repositionHandler = () => this.position();
            this.outsidePointerHandler = event => {
                const target = event.target as Node | null;
                if (!target || !this.container || this.container.contains(target)) return;
                const targetElement = target instanceof Element ? target : target.parentElement;
                if (targetElement?.closest(".dida-compact-repeat-overlay")) return;
                this.close();
            };
            this.windowBlurHandler = () => this.close();
            this.visibilityHandler = () => {
                if (document.visibilityState === "hidden") this.close();
            };
            document.addEventListener("keydown", this.escapeHandler);
            document.addEventListener("pointerdown", this.outsidePointerHandler, true);
            document.addEventListener("visibilitychange", this.visibilityHandler);
            window.addEventListener("resize", this.repositionHandler, { passive: true });
            window.addEventListener("blur", this.windowBlurHandler);
            document.addEventListener("scroll", this.repositionHandler, true);
        } catch (error) {
            this.close();
            throw error;
        }
    }

    private getScopeRect(): DOMRect {
        const explicit = this.scopeElement;
        const inferred = this.triggerElement?.closest(".workspace-leaf-content, .dida-timeline-custom-window, .modal") as HTMLElement | null;
        return (explicit || inferred)?.getBoundingClientRect() || new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    }

    position(): void {
        if (!this.container) return;
        const scope = this.getScopeRect();
        this.container.setCssStyles({
            maxWidth: `${Math.max(240, scope.width - 16)}px`,
            maxHeight: `${Math.max(240, scope.height - 16)}px`
        });
        if (this.overlay) {
            this.overlay.setCssStyles({
                top: `${scope.top}px`,
                left: `${scope.left}px`,
                width: `${scope.width}px`,
                height: `${scope.height}px`
            });
        }

        const popup = this.container.getBoundingClientRect();
        const margin = 8;
        let left = scope.left + Math.max(margin, (scope.width - popup.width) / 2);
        let top = scope.top + Math.max(margin, (scope.height - popup.height) / 2);
        if (this.triggerElement) {
            const trigger = this.triggerElement.getBoundingClientRect();
            left = trigger.right - popup.width;
            top = trigger.bottom + 6;
            if (top + popup.height > scope.bottom - margin) top = trigger.top - popup.height - 6;
        }
        left = Math.max(scope.left + margin, Math.min(left, scope.right - popup.width - margin));
        top = Math.max(scope.top + margin, Math.min(top, scope.bottom - popup.height - margin));
        this.container.setCssStyles({ left: `${left}px`, top: `${top}px` });
    }

    close(): void {
        if (this.escapeHandler) document.removeEventListener("keydown", this.escapeHandler);
        if (this.outsidePointerHandler) document.removeEventListener("pointerdown", this.outsidePointerHandler, true);
        if (this.visibilityHandler) document.removeEventListener("visibilitychange", this.visibilityHandler);
        if (this.repositionHandler) {
            window.removeEventListener("resize", this.repositionHandler);
            document.removeEventListener("scroll", this.repositionHandler, true);
        }
        if (this.windowBlurHandler) window.removeEventListener("blur", this.windowBlurHandler);
        this.overlay?.remove();
        this.container?.remove();
        this.overlay = null;
        this.container = null;
        this.escapeHandler = null;
        this.repositionHandler = null;
        this.outsidePointerHandler = null;
        this.windowBlurHandler = null;
        this.visibilityHandler = null;
        if (ScopedPopup.activePopup === this) ScopedPopup.activePopup = null;
    }
}

export class TaskSchedulePicker {
    app: App;
    state: TaskScheduleState;
    dateOnly: boolean;
    root: HTMLElement | null = null;
    calendar: HTMLElement | null = null;
    modeSwitch: HTMLElement | null = null;
    modeButton: HTMLButtonElement | null = null;
    timeRow: HTMLElement | null = null;
    repeatButton: HTMLButtonElement | null = null;

    constructor(app: App, options: TaskSchedulePickerOptions = {}) {
        this.app = app;
        this.state = createTaskScheduleState(options);
        this.dateOnly = options.dateOnly === true;
        if (this.dateOnly) this.state.isAllDay = true;
    }

    render(container: HTMLElement): void {
        this.root = container.createDiv("dida-task-schedule-picker");
        if (!this.dateOnly) this.renderModeAndTime(this.root);
        this.calendar = this.root.createDiv("dida-task-schedule-calendar");
        this.renderCalendar();
        this.updateVisibility();
    }

    private renderModeAndTime(container: HTMLElement): void {
        const controls = container.createDiv("dida-task-schedule-controls");
        this.modeSwitch = controls.createDiv("dida-schedule-mode-switch");
        this.modeButton = this.modeSwitch.createEl("button", { text: "全天" });
        this.modeButton.onclick = () => {
            this.state.isAllDay = !this.state.isAllDay;
            this.state.isScheduled = true;
            this.updateVisibility();
        };

        this.timeRow = controls.createDiv("dida-task-schedule-time-row");
        this.timeRow.createSpan({ text: "开始" });
        const startSelect = this.createTimeSelect(this.state.startMinutes, false);
        this.timeRow.createSpan({ text: "至" });
        const endSelect = this.createTimeSelect(this.state.endMinutes, true);
        startSelect.onchange = () => {
            setTaskScheduleStartMinutes(this.state, Number(startSelect.value));
            endSelect.value = String(this.state.endMinutes);
        };
        endSelect.onchange = () => {
            setTaskScheduleEndMinutes(this.state, Number(endSelect.value));
            endSelect.value = String(this.state.endMinutes);
        };
    }

    private createTimeSelect(value: number, allowEndOfDay: boolean): HTMLSelectElement {
        const select = this.timeRow!.createEl("select", { cls: "dida-task-schedule-time-select" });
        const limit = allowEndOfDay ? 1440 : 1425;
        for (let minutes = 0; minutes <= limit; minutes += TASK_SCHEDULE_STEP_MINUTES) {
            const hour = Math.floor(minutes / 60);
            const minute = minutes % 60;
            select.createEl("option", {
                value: String(minutes),
                text: minutes === 1440 ? "24:00" : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
            });
        }
        select.value = String(value);
        return select;
    }

    private updateVisibility(): void {
        if (!this.root) return;
        this.root.toggleClass("is-unscheduled", !this.state.isScheduled);
        if (this.modeButton) {
            const currentMode = this.state.isAllDay ? "全天" : "时间段";
            const nextMode = this.state.isAllDay ? "时间段" : "全天";
            this.modeButton.textContent = currentMode;
            this.modeButton.title = `切换到${nextMode}`;
            this.modeButton.setAttribute("aria-label", `当前${currentMode}，点击切换到${nextMode}`);
            this.modeButton.toggleClass("is-timed", !this.state.isAllDay);
        }
        this.timeRow?.setCssStyles({ display: !this.state.isAllDay && this.state.isScheduled ? "flex" : "none" });
        if (this.repeatButton) {
            this.repeatButton.disabled = !this.state.isScheduled;
            this.repeatButton.textContent = this.state.repeatFlag ? "已设置重复" : "重复设置";
        }
        this.renderCalendar();
    }

    private renderCalendar(): void {
        if (!this.calendar) return;
        this.calendar.empty();
        const nav = this.calendar.createDiv("dida-calendar-nav");
        nav.createEl("button", { text: "‹", attr: { "aria-label": "上个月" } }).onclick = () => {
            this.state.displayMonth--;
            if (this.state.displayMonth < 0) {
                this.state.displayMonth = 11;
                this.state.displayYear--;
            }
            this.renderCalendar();
        };
        nav.createSpan({ text: `${this.state.displayYear}年${this.state.displayMonth + 1}月`, cls: "dida-calendar-month-label" });
        nav.createEl("button", { text: "›", attr: { "aria-label": "下个月" } }).onclick = () => {
            this.state.displayMonth++;
            if (this.state.displayMonth > 11) {
                this.state.displayMonth = 0;
                this.state.displayYear++;
            }
            this.renderCalendar();
        };

        const week = this.calendar.createDiv("dida-calendar-week-header");
        ["日", "一", "二", "三", "四", "五", "六"].forEach(day => week.createDiv({ text: day, cls: "dida-calendar-week-day" }));
        const grid = this.calendar.createDiv("dida-calendar-grid");
        const first = new Date(this.state.displayYear, this.state.displayMonth, 1);
        const cursor = new Date(first);
        cursor.setDate(1 - first.getDay());
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        for (let index = 0; index < 42; index++) {
            const date = new Date(cursor);
            date.setDate(cursor.getDate() + index);
            date.setHours(0, 0, 0, 0);
            const day = grid.createDiv({ text: String(date.getDate()), cls: "dida-calendar-day" });
            if (date.getMonth() !== this.state.displayMonth) day.addClass("other-month");
            if (date.getTime() === today.getTime()) day.addClass("today");
            if (this.state.isScheduled && date.getTime() === this.state.selectedDate.getTime()) day.addClass("selected");
            day.onclick = () => {
                this.state.selectedDate = date;
                this.state.isScheduled = true;
                this.updateVisibility();
            };
        }
    }

    renderActions(container: HTMLElement, actions: TaskScheduleActions): void {
        const footer = container.createDiv("dida-calendar-buttons dida-task-schedule-actions");
        const clearButton = footer.createEl("button", { text: "清除" });
        clearButton.onclick = () => {
            clearTaskSchedule(this.state);
            this.updateVisibility();
        };
        const todayButton = footer.createEl("button", { text: "今天" });
        todayButton.onclick = () => {
            this.state.selectedDate = new Date();
            this.state.selectedDate.setHours(0, 0, 0, 0);
            this.state.displayYear = this.state.selectedDate.getFullYear();
            this.state.displayMonth = this.state.selectedDate.getMonth();
            this.state.isScheduled = true;
            this.updateVisibility();
        };
        this.repeatButton = footer.createEl("button", { text: this.state.repeatFlag ? "已设置重复" : "重复设置" });
        this.repeatButton.onclick = () => new CompactRepeatSettings(this.app, rule => {
            this.state.repeatFlag = rule;
            if (this.repeatButton) this.repeatButton.textContent = rule ? "已设置重复" : "重复设置";
        }, this.repeatButton!).show();
        if (this.dateOnly) this.repeatButton.setCssStyles({ display: "none" });
        this.repeatButton.disabled = !this.state.isScheduled;
        footer.createEl("button", { text: "取消" }).onclick = actions.onCancel;
        const primary = footer.createEl("button", { text: actions.primaryLabel, cls: "mod-cta" });
        primary.onclick = async () => {
            primary.disabled = true;
            try {
                const result = await actions.onSubmit(taskScheduleStateToValue(this.state));
                if (result === false) primary.disabled = false;
            } catch (error) {
                primary.disabled = false;
                throw error;
            }
        };
    }
}
