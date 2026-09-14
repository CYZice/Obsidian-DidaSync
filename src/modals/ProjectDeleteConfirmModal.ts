import { Modal } from "obsidian";
import DidaSyncPlugin from "../main";
import { ProjectCatalogEntry } from "../types";

export class ProjectDeleteConfirmModal extends Modal {
    plugin: DidaSyncPlugin;
    project: ProjectCatalogEntry;
    onConfirm: () => void;

    constructor(app: any, plugin: DidaSyncPlugin, project: ProjectCatalogEntry, onConfirm: () => void) {
        super(app);
        this.plugin = plugin;
        this.project = project;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const content = this.contentEl;
        content.empty();
        content.createEl("h3", { text: this.plugin.t("modal.projectDelete.title", { name: this.plugin.getProjectDisplayName(this.project.name) }) });
        content.createEl("p", {
            text: this.plugin.t("modal.projectDelete.desc")
        });

        const footer = content.createDiv("dida-modal-actions-row");
        footer.createEl("button", { text: this.plugin.t("common.cancel") }).addEventListener("click", () => this.close());
        const confirm = footer.createEl("button", { text: this.plugin.t("common.delete") });
        confirm.addClass("mod-warning");
        confirm.addEventListener("click", () => {
            this.onConfirm();
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
