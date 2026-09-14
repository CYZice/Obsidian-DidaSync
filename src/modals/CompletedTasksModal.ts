import { Modal, Notice, setIcon } from "obsidian";
import DidaSyncPlugin from "../main";
import { DatePickerModal } from "./DatePickerModal";
import { DidaTask } from "../types";

export class CompletedTasksModal extends Modal {
    plugin: DidaSyncPlugin;
    startFieldEl: HTMLElement | null = null;
    endFieldEl: HTMLElement | null = null;
    resultEl: HTMLElement | null = null;
    loadingEl: HTMLElement | null = null;
    currentQuery: any = {};

    constructor(app: any, plugin: DidaSyncPlugin) {
        super(app);
        this.plugin = plugin;
        this.currentQuery = {
            ...this.plugin.buildDefaultCompletedTaskQuery(),
            ...(this.plugin.settings.completedTasksQuery || {})
        };
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("dida-completed-modal");
        contentEl.createEl("h3", { text: this.plugin.t("completed.title") });

        const controls = contentEl.createDiv("dida-completed-controls");
        const startWrap = controls.createDiv("dida-completed-control");
        this.startFieldEl = startWrap.createDiv("dida-completed-date-field");
        this.startFieldEl.addEventListener("click", () => this.openDatePicker("start"));

        const endWrap = controls.createDiv("dida-completed-control");
        this.endFieldEl = endWrap.createDiv("dida-completed-date-field");
        this.endFieldEl.addEventListener("click", () => this.openDatePicker("end"));

        const actions = controls.createDiv("dida-completed-actions");
        const refreshBtn = actions.createEl("button", { text: this.plugin.t("completed.query") });
        refreshBtn.addClass("mod-cta");
        refreshBtn.addEventListener("click", () => void this.runQuery());

        const presetBtn = actions.createEl("button", { text: this.plugin.t("completed.last7") });
        presetBtn.addEventListener("click", () => {
            const preset = this.plugin.buildDefaultCompletedTaskQuery();
            this.currentQuery = preset;
            this.renderDateFields();
        });

        this.loadingEl = contentEl.createDiv("dida-completed-loading");
        this.resultEl = contentEl.createDiv("dida-completed-results");
        this.currentQuery = this.plugin.buildDefaultCompletedTaskQuery();
        this.renderDateFields();
        void this.runQuery();
    }

    extractDateValue(value?: string) {
        if (!value) return "";
        const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : "";
    }

    formatDateOnly(date: Date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }

    buildQueryFromInputs() {
        const query: any = {};
        if (this.currentQuery.startDate) query.startDate = this.currentQuery.startDate;
        if (this.currentQuery.endDate) query.endDate = this.currentQuery.endDate;
        return query;
    }

    renderDateFields() {
        if (this.startFieldEl) {
            this.startFieldEl.empty();
            this.startFieldEl.createSpan({ cls: "dida-completed-date-field-label", text: this.plugin.t("completed.startDate") });
            this.startFieldEl.createSpan({ cls: "dida-completed-date-field-value", text: this.extractDateValue(this.currentQuery.startDate) || this.plugin.t("completed.chooseDate") });
        }
        if (this.endFieldEl) {
            this.endFieldEl.empty();
            this.endFieldEl.createSpan({ cls: "dida-completed-date-field-label", text: this.plugin.t("completed.endDate") });
            this.endFieldEl.createSpan({ cls: "dida-completed-date-field-value", text: this.extractDateValue(this.currentQuery.endDate) || this.plugin.t("completed.chooseDate") });
        }
    }

    openDatePicker(kind: "start" | "end") {
        const fieldEl = kind === "start" ? this.startFieldEl : this.endFieldEl;
        const currentValue = kind === "start" ? this.currentQuery.startDate : this.currentQuery.endDate;
        new DatePickerModal(
            this.app,
            currentValue || null,
            (date) => {
                if (!date) return;
                const dateOnly = this.formatDateOnly(date);
                if (kind === "start") {
                    this.currentQuery.startDate = this.plugin.formatDidaDateTime(new Date(`${dateOnly}T00:00:00`));
                } else {
                    this.currentQuery.endDate = this.plugin.formatDidaDateTime(new Date(`${dateOnly}T23:59:59.999`));
                }
                this.renderDateFields();
            },
            fieldEl,
            this.plugin,
            null,
            { dateOnly: true }
        ).open();
    }

    async runQuery() {
        if (!this.loadingEl) return;
        this.loadingEl.textContent = this.plugin.t("completed.loading");
        try {
            const query = this.buildQueryFromInputs();
            this.currentQuery = query;
            const tasks = await this.plugin.fetchCompletedTasks(query);
            await this.renderResults(tasks || []);
            this.loadingEl.textContent = this.plugin.t("completed.totalCount", { count: tasks.length });
        } catch (e: any) {
            this.loadingEl.textContent = "";
            new Notice(e?.message || this.plugin.t("completed.fetchFailed"));
        }
    }

    async renderResults(tasks: DidaTask[]) {
        if (!this.resultEl) return;
        this.resultEl.empty();
        if (!Array.isArray(tasks) || tasks.length === 0) {
            this.resultEl.createEl("p", { text: this.plugin.t("completed.empty"), cls: "dida-empty-state" });
            return;
        }

        tasks
            .slice()
            .sort((a, b) => new Date(b.completedTime || 0 as any).getTime() - new Date(a.completedTime || 0 as any).getTime())
            .forEach((task) => {
                const item = this.resultEl!.createDiv("dida-completed-item");

                // Header: checkbox + title
                const header = item.createDiv("dida-completed-item-header");
                const checkbox = header.createDiv("dida-completed-checkbox checked");
                setIcon(checkbox, "check");
                checkbox.addEventListener("click", async () => {
                    checkbox.classList.add("is-dimmed");
                    try {
                        await this.plugin.restoreCompletedTask(task);
                        const nextTasks = (this.plugin.settings.completedTasks || []).filter((item) => item.didaId !== task.didaId);
                        await this.renderResults(nextTasks);
                        if (this.loadingEl) {
                            this.loadingEl.textContent = this.plugin.t("completed.totalCount", { count: nextTasks.length });
                        }
                    } catch (e: any) {
                        new Notice(e?.message || this.plugin.t("completed.restoreFailed"));
                        checkbox.classList.remove("is-dimmed");
                    }
                });
                const titleEl = header.createEl("span", {
                    text: task.title || this.plugin.t("common.untitledTask"),
                    cls: "dida-completed-item-title"
                });

                // Meta: completion time + original due date
                const meta = item.createDiv("dida-completed-item-meta");
                const parts = [
                    task.completedTime ? this.plugin.t("completed.completedAt", { time: this.extractDateValue(task.completedTime) }) : "",
                    task.dueDate ? this.plugin.t("completed.originalPlan", { time: this.extractDateValue(task.dueDate) }) : ""
                ].filter(Boolean);
                meta.textContent = parts.join("  ·  ");
            });
    }

    onClose() {
        this.contentEl.empty();
    }
}
