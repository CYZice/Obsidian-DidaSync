import { App, Modal, Setting } from "obsidian";
import { SyncDeletionCandidate } from "../types";

export class SyncDeletionReviewModal extends Modal {
    constructor(
        app: App,
        private candidate: SyncDeletionCandidate,
        private resolveCandidate: (action: "delete_remote" | "detach") => Promise<void>,
        private closed?: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "确认本地删除如何同步" });
        contentEl.createEl("p", { text: `检测到本地${this.candidate.entityKind === "note" ? "笔记文件" : "任务行"}已删除：${this.candidate.title}` });
        if (this.candidate.path) contentEl.createEl("p", { text: this.candidate.path, cls: "setting-item-description" });
        contentEl.createEl("p", { text: "为防止误删，云端内容尚未删除。请选择后续操作。" });
        new Setting(contentEl)
            .addButton(button => button.setButtonText("仅解除关联").onClick(async () => {
                await this.resolveCandidate("detach");
                this.close();
            }))
            .addButton(button => button.setWarning().setButtonText("删除云端").onClick(async () => {
                await this.resolveCandidate("delete_remote");
                this.close();
            }));
    }

    onClose() {
        this.contentEl.empty();
        this.closed?.();
    }
}
