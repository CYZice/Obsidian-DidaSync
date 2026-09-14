import { Modal, Notice } from "obsidian";
import DidaSyncPlugin from "../main";
import { ProjectCatalogEntry } from "../types";

export class ProjectRenameModal extends Modal {
    plugin: DidaSyncPlugin;
    project: ProjectCatalogEntry;
    onSubmit: (name: string) => void;
    inputEl: HTMLInputElement | null = null;
    submitted: boolean = false;

    constructor(app: any, plugin: DidaSyncPlugin, project: ProjectCatalogEntry, onSubmit: (name: string) => void) {
        super(app);
        this.plugin = plugin;
        this.project = project;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const content = this.contentEl;
        content.empty();
        content.createEl("h3", { text: this.plugin.t("modal.projectRename.title", { name: this.plugin.getProjectDisplayName(this.project.name) }) });
        content.createEl("p", {
            text: this.plugin.t("modal.projectRename.desc")
        });
        this.inputEl = content.createEl("input", {
            type: "text",
            value: this.project.name
        });
        this.inputEl.addClass("dida-modal-input-full", "dida-modal-input-margin-md");

        const footer = content.createDiv("dida-modal-actions-row");
        footer.createEl("button", { text: this.plugin.t("common.cancel") }).addEventListener("click", () => this.close());
        const confirm = footer.createEl("button", { text: this.plugin.t("common.confirm") });
        confirm.addClass("mod-cta");
        confirm.addEventListener("click", () => this.submit());
        this.inputEl.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.submit();
            }
        });

        window.setTimeout(() => {
            this.inputEl?.focus();
            this.inputEl?.select();
        }, 0);
    }

    submit() {
        const value = (this.inputEl?.value || "").trim();
        if (!value) {
            new Notice(this.plugin.t("error.projectNameEmpty"));
            this.inputEl?.focus();
            this.inputEl?.select();
            return;
        }
        this.submitted = true;
        this.onSubmit(value);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}
