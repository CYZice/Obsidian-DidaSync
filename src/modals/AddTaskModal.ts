import { App, Notice } from "obsidian";
import DidaSyncPlugin from "../main";
import { MessageKey, MessageParams } from "../i18n";
import { TaskScheduleInput } from "../types";
import { ScopedPopup, TaskSchedulePicker } from "./TaskSchedulePicker";

export interface TaskCreateProject {
    id: string;
    name: string;
}

interface AddTaskModalOptions {
    plugin: DidaSyncPlugin;
    projects: TaskCreateProject[];
    defaultProjectId?: string;
    defaultDate?: Date;
    triggerElement?: HTMLElement | null;
    scopeElement?: HTMLElement | null;
}

export class AddTaskModal {
    app: App;
    onSubmit: (title: string, project: TaskCreateProject, schedule: TaskScheduleInput) => void | Promise<void>;
    options: AddTaskModalOptions;
    popup: ScopedPopup;

    constructor(
        app: App,
        onSubmit: (title: string, project: TaskCreateProject, schedule: TaskScheduleInput) => void | Promise<void>,
        options: AddTaskModalOptions
    ) {
        this.app = app;
        this.onSubmit = onSubmit;
        this.options = options;
        this.popup = new ScopedPopup(options.triggerElement || null, options.scopeElement || null, "dida-task-create-popup");
    }

    open(): void {
        const t = (key: MessageKey, params?: MessageParams) => this.options.plugin.t(key, params);
        this.popup.open(container => {
            const fields = container.createDiv("dida-task-create-fields");
            fields.createEl("h3", { text: t("modal.addTask.title") });
            const primaryRow = fields.createDiv("dida-task-create-primary-row");
            const titleInput = primaryRow.createEl("input", {
                type: "text",
                placeholder: t("modal.addTask.titlePlaceholder"),
                cls: "dida-task-create-title"
            });
            const projectSelect = primaryRow.createEl("select", {
                cls: "dida-task-create-project-select",
                attr: { "aria-label": t("modal.addTask.project"), title: t("modal.addTask.chooseProject") }
            });
            this.options.projects.forEach(project => {
                projectSelect.createEl("option", { text: this.options.plugin.getProjectDisplayName(project.name), value: project.id });
            });
            projectSelect.value = this.options.defaultProjectId || this.options.projects[0]?.id || "inbox";

            const picker = new TaskSchedulePicker(this.app, {
                plugin: this.options.plugin,
                defaultDate: this.options.defaultDate || new Date(),
                isAllDay: true
            });
            picker.render(container);
            picker.renderActions(container, {
                primaryLabel: t("modal.addTask.primary"),
                onCancel: () => this.close(),
                onSubmit: async value => {
                    const title = titleInput.value.trim();
                    if (!title) {
                        new Notice(t("modal.addTask.titleEmpty"));
                        titleInput.focus();
                        return false;
                    }
                    const project = this.options.projects.find(item => item.id === projectSelect.value) || this.options.projects[0];
                    if (!project) {
                        new Notice(t("modal.addTask.noProjects"));
                        return false;
                    }
                    await this.onSubmit(title, project, {
                        startDate: value.startDate ? value.startDate.toISOString() : null,
                        dueDate: value.dueDate ? value.dueDate.toISOString() : null,
                        isAllDay: value.isAllDay,
                        repeatFlag: value.repeatFlag
                    });
                    this.close();
                }
            });

            titleInput.addEventListener("keydown", event => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    (container.querySelector(".dida-task-schedule-actions .mod-cta") as HTMLButtonElement | null)?.click();
                }
            });
            setTimeout(() => titleInput.focus(), 50);
        });
    }

    close(): void {
        this.popup.close();
    }
}
