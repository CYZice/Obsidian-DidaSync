import { Modal } from "obsidian";
import DidaSyncPlugin from "../main";
import { SyncFailureDetail, SyncResult } from "../types";

export class SyncFailureModal extends Modal {
    constructor(app: any, private plugin: DidaSyncPlugin, private result: SyncResult) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("dida-sync-failure-modal");
        contentEl.createEl("h2", { text: this.plugin.t("modal.syncFailure.title") });

        const details = this.result.failedDetails || [];
        const scopeFailures = this.result.failedScopes || [];
        const operationFailures = this.result.failedOperations || [];
        const summary = contentEl.createDiv("dida-sync-failure-summary");
        summary.setText(this.plugin.t("modal.syncFailure.summary", {
            uploaded: this.result.uploaded,
            downloaded: this.result.downloaded,
            failed: Math.max(details.length, operationFailures.length) + scopeFailures.length
        }));

        if (details.length === 0 && scopeFailures.length === 0 && operationFailures.length === 0) {
            contentEl.createDiv({ text: this.plugin.t("modal.syncFailure.empty"), cls: "dida-sync-failure-empty" });
            return;
        }

        const list = contentEl.createEl("ol", { cls: "dida-sync-failure-list" });
        for (const detail of details) this.renderDetail(list, detail);
        for (const scope of scopeFailures) {
            const item = list.createEl("li");
            item.createEl("div", { text: this.plugin.t("modal.syncFailure.scope", { scope }), cls: "dida-sync-failure-title" });
            item.createEl("div", { text: this.plugin.t("modal.syncFailure.scopeReason"), cls: "dida-sync-failure-reason" });
        }
        if (details.length === 0) {
            for (const reason of operationFailures) {
                const item = list.createEl("li");
                item.createEl("div", { text: this.plugin.t("modal.syncFailure.operationFailed"), cls: "dida-sync-failure-title" });
                item.createEl("div", { text: this.plugin.t("modal.syncFailure.reason", { reason }), cls: "dida-sync-failure-reason" });
            }
        }

        const close = contentEl.createEl("button", { text: this.plugin.t("modal.syncFailure.close") });
        close.addEventListener("click", () => this.close());
    }

    private renderDetail(list: HTMLOListElement, detail: SyncFailureDetail) {
        const item = list.createEl("li");
        const title = detail.title?.trim() || detail.localTaskId || detail.didaId || this.plugin.t("common.untitledTask");
        const operation = this.getOperationLabel(detail.operation);
        item.createEl("div", { text: `${title} · ${operation}`, cls: "dida-sync-failure-title" });
        if (detail.projectName) item.createEl("div", { text: this.plugin.t("modal.syncFailure.projectLabel", { name: this.plugin.getProjectDisplayName(detail.projectName) }), cls: "dida-sync-failure-meta" });
        item.createEl("div", { text: this.plugin.t("modal.syncFailure.reason", { reason: detail.reason }), cls: "dida-sync-failure-reason" });
        if (detail.attempts) item.createEl("div", { text: this.plugin.t("modal.syncFailure.retried", { count: detail.attempts }), cls: "dida-sync-failure-meta" });
    }

    private getOperationLabel(operation?: string) {
        switch (operation) {
            case "upsert": return this.plugin.t("sync.operation.upsert");
            case "complete": return this.plugin.t("sync.operation.complete");
            case "delete": return this.plugin.t("sync.operation.delete");
            case "placement": return this.plugin.t("sync.operation.placement");
            default: return operation || this.plugin.t("sync.operation.default");
        }
    }
}
