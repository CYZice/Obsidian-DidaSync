import { App, Modal, Notice, Setting } from "obsidian";
import DidaSyncPlugin from "../main";
import { ProjectCatalogEntry } from "../types";

export class ProjectVisibilityModal extends Modal {
    plugin: DidaSyncPlugin;
    onChange: () => void;

    constructor(app: App, plugin: DidaSyncPlugin, onChange: () => void) {
        super(app);
        this.plugin = plugin;
        this.onChange = onChange;
    }

    onOpen() {
        this.render();
    }

    render() {
        const content = this.contentEl;
        content.empty();
        content.createEl("h3", { text: this.plugin.t("modal.visibility.title") });

        const projects = this.getProjects();
        if (projects.length === 0) {
            content.createDiv("dida-settings-info", { text: this.plugin.t("modal.visibility.empty") });
        } else {
            projects.forEach((project) => this.renderProjectRow(content, project));
        }

        const footer = content.createDiv("dida-modal-actions-row");
        const closeButton = footer.createEl("button", { text: this.plugin.t("modal.visibility.done") });
        closeButton.addClass("mod-cta");
        closeButton.addEventListener("click", () => this.close());
    }

    getProjects(): ProjectCatalogEntry[] {
        return this.plugin.getAvailableProjectConfigs()
            .filter((project) => this.plugin.settings.showArchivedProjects || !project.isArchived);
    }

    renderProjectRow(containerEl: HTMLElement, project: ProjectCatalogEntry) {
        const taskCount = this.plugin.getProjectTaskCount(project);
        const descParts = [this.plugin.t("modal.visibility.taskCount", { count: taskCount })];
        if (project.isArchived) descParts.push(this.plugin.t("modal.visibility.archived"));

        const isInbox = this.plugin.isInboxProject(project.id, project.name);
        if (isInbox) descParts.push(this.plugin.t("modal.visibility.alwaysShown"));

        new Setting(containerEl)
            .setName(this.plugin.getProjectDisplayName(project.name))
            .setDesc(descParts.join(this.plugin.t("modal.visibility.join")))
            .addToggle((toggle) => {
                toggle
                    .setValue(isInbox || this.plugin.isProjectVisible(project.id, project.name))
                    .onChange(async (value) => {
                        if (isInbox) {
                            new Notice(this.plugin.t("modal.visibility.inboxLocked"));
                            this.render();
                            return;
                        }
                        await this.plugin.setProjectHidden(project.id, project.name, !value);
                        this.onChange();
                        this.render();
                    });
            });
    }

    onClose() {
        this.contentEl.empty();
    }
}
