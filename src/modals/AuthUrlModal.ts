import { App, Modal, Setting } from "obsidian";
import DidaSyncPlugin from "../main";

export class AuthUrlModal extends Modal {
    plugin: DidaSyncPlugin;
    url: string;
    redirectUri: string;

    constructor(app: App, plugin: DidaSyncPlugin, url: string, redirectUri: string) {
        super(app);
        this.plugin = plugin;
        this.url = url;
        this.redirectUri = redirectUri;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: this.plugin.t("modal.auth.title") });
        contentEl.createEl("p", { text: this.plugin.t("modal.auth.manualOpen") });
        const box = contentEl.createDiv("dida-auth-box");
        box.createEl("code", { text: this.url });
        contentEl.createEl("p", { text: this.plugin.t("modal.auth.redirectExpect") });
        contentEl.createEl("code", { text: this.redirectUri });
        new Setting(contentEl).addButton(btn => {
            btn.setButtonText(this.plugin.t("common.close")).onClick(() => this.close());
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
