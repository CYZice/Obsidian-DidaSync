import { App } from "obsidian";
import DidaSyncPlugin from "../main";
import { ScopedPopup, TaskSchedulePicker } from "./TaskSchedulePicker";
import { DatePickerModalInitialSchedule, hasExplicitSchedule, resolveDatePickerInitialSchedule } from "./datePickerSchedule";

export class DatePickerModal {
    app: App;
    currentDate: string | Date | null;
    onDateSelect: (date: Date | null, isAllDay: boolean, endDate?: Date, repeatFlag?: string | null) => void | Promise<void>;
    triggerElement: HTMLElement | null;
    plugin: DidaSyncPlugin | null;
    taskIndex: number | null;
    dateOnly: boolean;
    popup: ScopedPopup;
    initialSchedule: DatePickerModalInitialSchedule | null;

    constructor(
        app: App,
        currentDate: string | Date | null,
        onDateSelect: (date: Date | null, isAllDay: boolean, endDate?: Date, repeatFlag?: string | null) => void | Promise<void>,
        triggerElement: HTMLElement | null,
        plugin: DidaSyncPlugin | null = null,
        taskIndex: number | null = null,
        options: { dateOnly?: boolean; scopeElement?: HTMLElement | null; initialSchedule?: DatePickerModalInitialSchedule | null; popupClass?: string } = {}
    ) {
        this.app = app;
        this.currentDate = currentDate;
        this.onDateSelect = onDateSelect;
        this.triggerElement = triggerElement;
        this.plugin = plugin;
        this.taskIndex = taskIndex;
        this.dateOnly = options.dateOnly === true;
        this.initialSchedule = options.initialSchedule || null;
        this.popup = new ScopedPopup(triggerElement, options.scopeElement || null, options.popupClass || "");
    }

    open(): void {
        const task = this.plugin && this.taskIndex !== null ? this.plugin.settings.tasks[this.taskIndex] : null;
        const schedule = resolveDatePickerInitialSchedule(task, this.initialSchedule);
        const hasTaskSchedule = hasExplicitSchedule(schedule);
        const fallbackCurrentSchedule = !hasTaskSchedule && this.currentDate
            ? {
                startDate: this.currentDate,
                dueDate: this.dateOnly ? this.currentDate : null,
                isAllDay: true,
                repeatFlag: null
            }
            : null;
        const pickerSchedule = fallbackCurrentSchedule || schedule;
        this.popup.open(container => {
            const picker = new TaskSchedulePicker(this.app, {
                startDate: pickerSchedule?.startDate || null,
                dueDate: pickerSchedule?.dueDate || null,
                isAllDay: this.dateOnly ? true : (hasExplicitSchedule(pickerSchedule) && typeof pickerSchedule?.isAllDay === "boolean" ? pickerSchedule.isAllDay : true),
                repeatFlag: pickerSchedule?.repeatFlag || null,
                isScheduled: hasTaskSchedule || !!fallbackCurrentSchedule,
                dateOnly: this.dateOnly
            });
            picker.render(container);
            picker.renderActions(container, {
                primaryLabel: "确认",
                onCancel: () => this.close(),
                onSubmit: async value => {
                    await this.onDateSelect(value.startDate, value.isAllDay, value.dueDate || undefined, value.repeatFlag);
                    this.close();
                }
            });
        });
    }

    close(): void {
        this.popup.close();
    }
}
