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
        contentEl.createEl("h2", { text: "同步失败明细" });

        const details = this.result.failedDetails || [];
        const scopeFailures = this.result.failedScopes || [];
        const operationFailures = this.result.failedOperations || [];
        const summary = contentEl.createDiv("dida-sync-failure-summary");
        summary.setText(`已上传 ${this.result.uploaded} 项，已下载 ${this.result.downloaded} 项，失败 ${Math.max(details.length, operationFailures.length) + scopeFailures.length} 项。`);

        if (details.length === 0 && scopeFailures.length === 0 && operationFailures.length === 0) {
            contentEl.createDiv({ text: "未能获取更具体的失败信息，请查看开发者控制台日志。", cls: "dida-sync-failure-empty" });
            return;
        }

        const list = contentEl.createEl("ol", { cls: "dida-sync-failure-list" });
        for (const detail of details) this.renderDetail(list, detail);
        for (const scope of scopeFailures) {
            const item = list.createEl("li");
            item.createEl("div", { text: `同步范围：${scope}`, cls: "dida-sync-failure-title" });
            item.createEl("div", { text: "该清单或任务范围未能拉取完整数据。", cls: "dida-sync-failure-reason" });
        }
        if (details.length === 0) {
            for (const reason of operationFailures) {
                const item = list.createEl("li");
                item.createEl("div", { text: "同步操作失败", cls: "dida-sync-failure-title" });
                item.createEl("div", { text: `原因：${reason}`, cls: "dida-sync-failure-reason" });
            }
        }

        const close = contentEl.createEl("button", { text: "关闭" });
        close.addEventListener("click", () => this.close());
    }

    private renderDetail(list: HTMLOListElement, detail: SyncFailureDetail) {
        const item = list.createEl("li");
        const title = detail.title?.trim() || detail.localTaskId || detail.didaId || "未命名任务";
        const operation = this.getOperationLabel(detail.operation);
        item.createEl("div", { text: `${title} · ${operation}`, cls: "dida-sync-failure-title" });
        if (detail.projectName) item.createEl("div", { text: `清单：${detail.projectName}`, cls: "dida-sync-failure-meta" });
        item.createEl("div", { text: `原因：${detail.reason}`, cls: "dida-sync-failure-reason" });
        if (detail.attempts) item.createEl("div", { text: `已重试 ${detail.attempts} 次`, cls: "dida-sync-failure-meta" });
    }

    private getOperationLabel(operation?: string) {
        switch (operation) {
            case "upsert": return "上传/更新";
            case "complete": return "同步完成状态";
            case "delete": return "删除";
            case "placement": return "移动清单/父任务";
            default: return operation || "同步";
        }
    }
}
