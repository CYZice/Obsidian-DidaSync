import { Modal, Notice } from "obsidian";
import DidaSyncPlugin from "../main";

export class ProjectCreateModal extends Modal {
    plugin: DidaSyncPlugin;
    onSubmit: (name: string) => void;
    inputEl: HTMLInputElement | null = null;
    submitted: boolean = false;

    constructor(app: any, plugin: DidaSyncPlugin, onSubmit: (name: string) => void) {
        super(app);
        this.plugin = plugin;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const content = this.contentEl;
        content.empty();
        content.createEl("h3", { text: this.plugin.t("modal.projectCreate.title") });
        content.createEl("p", {
            text: this.plugin.t("modal.projectCreate.desc")
        });
        this.inputEl = content.createEl("input", {
            type: "text",
            placeholder: this.plugin.t("modal.projectCreate.placeholder")
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
