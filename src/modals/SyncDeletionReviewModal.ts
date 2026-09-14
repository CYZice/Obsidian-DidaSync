import { App, Modal, Setting } from "obsidian";
import DidaSyncPlugin from "../main";
import { MessageKey, MessageParams } from "../i18n";
import { SyncDeletionCandidate } from "../types";

export class SyncDeletionReviewModal extends Modal {
    constructor(
        app: App,
        private plugin: DidaSyncPlugin,
        private candidate: SyncDeletionCandidate,
        private resolveCandidate: (action: "delete_remote" | "detach") => Promise<void>,
        private closed?: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        const t = (key: MessageKey, params?: MessageParams) => this.plugin.t(key, params);
        contentEl.empty();
        contentEl.createEl("h2", { text: t("modal.deletionReview.title") });
        contentEl.createEl("p", {
            text: t("modal.deletionReview.detected", {
                kind: this.candidate.entityKind === "note" ? t("modal.deletionReview.kindNote") : t("modal.deletionReview.kindTask"),
                title: this.candidate.title
            })
        });
        if (this.candidate.path) contentEl.createEl("p", { text: this.candidate.path, cls: "setting-item-description" });
        contentEl.createEl("p", { text: t("modal.deletionReview.safety") });
        new Setting(contentEl)
            .addButton(button => button.setButtonText(t("modal.deletionReview.detach")).onClick(async () => {
                await this.resolveCandidate("detach");
                this.close();
            }))
            .addButton(button => button.setWarning().setButtonText(t("modal.deletionReview.deleteRemote")).onClick(async () => {
                await this.resolveCandidate("delete_remote");
                this.close();
            }));
    }

    onClose() {
        this.contentEl.empty();
        this.closed?.();
    }
}
