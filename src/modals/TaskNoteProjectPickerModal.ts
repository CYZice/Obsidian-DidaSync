import { App, Modal, Notice, Setting } from "obsidian";
import DidaSyncPlugin from "../main";
import { ProjectCatalogEntry } from "../types";

export interface TaskNoteProjectPickerOptions {
    title?: string;
    selectionLabel?: string;
    emptyText?: string;
    requireSelection?: boolean;
    getProjectKey?: (project: ProjectCatalogEntry) => string;
    getProjects?: () => ProjectCatalogEntry[];
    saveSelection?: (keys: string[]) => Promise<void> | void;
}

export class TaskNoteProjectPickerModal extends Modal {
    plugin: DidaSyncPlugin;
    selectedProjectKeys: string[];
    onSelectionChange: (keys: string[]) => void;
    options: Required<Omit<TaskNoteProjectPickerOptions, "saveSelection" | "getProjectKey" | "getProjects">> & {
        getProjectKey: (project: ProjectCatalogEntry) => string;
        getProjects?: () => ProjectCatalogEntry[];
        saveSelection?: (keys: string[]) => Promise<void> | void;
    };

    constructor(
        app: App,
        plugin: DidaSyncPlugin,
        selectedProjectKeys: string[],
        onSelectionChange: (keys: string[]) => void,
        options: TaskNoteProjectPickerOptions = {}
    ) {
        super(app);
        this.plugin = plugin;
        this.selectedProjectKeys = [...selectedProjectKeys];
        this.onSelectionChange = onSelectionChange;
        this.options = {
            title: options.title || this.plugin.t("modal.projectPicker.title"),
            selectionLabel: options.selectionLabel || this.plugin.t("modal.projectPicker.selectionLabel"),
            emptyText: options.emptyText || this.plugin.t("modal.projectPicker.empty"),
            requireSelection: options.requireSelection !== false,
            getProjectKey: options.getProjectKey || ((project) => this.plugin.getProjectFilterKey(project.id, project.name)),
            getProjects: options.getProjects,
            saveSelection: options.saveSelection
        };
    }

    onOpen() {
        this.render();
    }

    render() {
        const content = this.contentEl;
        content.empty();
        content.createEl("h3", { text: this.options.title });

        const projects = this.getProjectOptions();
        if (projects.length === 0) {
            content.createDiv("dida-settings-info", { text: this.options.emptyText });
        } else {
            const controls = new Setting(content)
                .setName(this.options.selectionLabel)
                .setDesc(this.plugin.t("modal.projectPicker.selectedCount", { count: this.selectedProjectKeys.length }));
            controls.addButton((button) => button
                .setButtonText(this.plugin.t("modal.projectPicker.selectAll"))
                .onClick(() => {
                    this.selectedProjectKeys = projects.map((project) => this.options.getProjectKey(project)).filter(Boolean);
                    this.render();
                }));
            controls.addButton((button) => button
                .setButtonText(this.plugin.t("modal.projectPicker.clear"))
                .onClick(() => {
                    this.selectedProjectKeys = [];
                    this.render();
                }));

            projects.forEach((project) => this.renderProjectRow(content, project));
        }

        const footer = content.createDiv("dida-modal-actions-row");
        footer.createEl("button", { text: this.plugin.t("common.cancel") }).addEventListener("click", () => this.close());
        const confirm = footer.createEl("button", { text: this.plugin.t("modal.projectPicker.done") });
        confirm.addClass("mod-cta");
        confirm.addEventListener("click", async () => {
            if (this.options.requireSelection && this.selectedProjectKeys.length === 0) {
                new Notice(this.plugin.t("modal.projectPicker.requireOne"));
                return;
            }
            await this.saveSelection();
            this.close();
        });
    }

    getProjectOptions(): ProjectCatalogEntry[] {
        const projects = this.options.getProjects ? this.options.getProjects() : this.plugin.getAvailableProjectConfigs();
        return projects
            .filter((project) => this.plugin.settings.showArchivedProjects || !project.isArchived);
    }

    renderProjectRow(containerEl: HTMLElement, project: ProjectCatalogEntry) {
        const key = this.options.getProjectKey(project);
        if (!key) return;
        const taskCount = this.plugin.getProjectTaskCount(project);
        const descParts = [this.plugin.t("modal.visibility.taskCount", { count: taskCount })];
        if (!this.plugin.isProjectVisible(project.id, project.name)) descParts.push(this.plugin.t("modal.visibility.hiddenInSidebar"));
        if (project.isArchived) descParts.push(this.plugin.t("modal.visibility.archived"));

        new Setting(containerEl)
            .setName(this.plugin.getProjectDisplayName(project.name))
            .setDesc(descParts.join(this.plugin.t("modal.visibility.join")))
            .addToggle((toggle) => toggle
                .setValue(this.selectedProjectKeys.includes(key))
                .onChange((value) => {
                    const next = new Set(this.selectedProjectKeys);
                    if (value) next.add(key);
                    else next.delete(key);
                    this.selectedProjectKeys = Array.from(next);
                    this.render();
                }));
    }

    async saveSelection() {
        if (this.options.saveSelection) {
            await this.options.saveSelection([...this.selectedProjectKeys]);
        } else {
            this.plugin.settings.taskNoteSyncProjectKeys = [...this.selectedProjectKeys];
            await this.plugin.saveSettings();
        }
        this.onSelectionChange([...this.selectedProjectKeys]);
    }

    onClose() {
        this.contentEl.empty();
    }
}
