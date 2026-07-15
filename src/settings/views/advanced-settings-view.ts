import { App, Notice, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";

export class AdvancedSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "维护与数据" });

        const cleanInfo = containerEl.createDiv("dida-settings-info dida-settings-info--muted");
        cleanInfo.setText("说明：启用自动清理后，插件会在每次启动后延迟 30 秒，自动清理指定时间之前的已完成任务数据。该操作只影响本地数据，不会影响滴答清单云端数据。");

        new Setting(containerEl)
            .setName("自动清理已完成任务")
            .setDesc("启用后会在插件启动时自动清理指定时间之前的已完成任务数据")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.autoCleanCompletedTasks)
                .onChange(async (value) => {
                    this.plugin.settings.autoCleanCompletedTasks = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("清理间隔")
            .setDesc("自动清理已完成任务的时间间隔（月数）")
            .addDropdown((dropdown) => {
                for (let month = 1; month <= 12; month++) {
                    dropdown.addOption(month.toString(), `${month} 个月`);
                }
                dropdown
                    .setValue(this.plugin.settings.autoCleanInterval.toString())
                    .onChange(async (value) => {
                        this.plugin.settings.autoCleanInterval = parseInt(value, 10);
                        await this.plugin.saveSettings();
                    });
            });

        containerEl.createEl("h3", { text: "数据重置" });

        const resetInfo = containerEl.createDiv("dida-settings-info dida-settings-info--warning");
        resetInfo.setText("警告：该操作会清空本地任务数据，并重新从滴答清单云端拉取最新数据。此操作不可逆，建议在备份仓库后使用。适用于本地任务数据损坏或异常的场景。");

        new Setting(containerEl)
            .setName("重置任务数据")
            .setDesc("清空本地任务数据，并重新从云端获取任务到 Obsidian")
            .addButton((button) => button
                .setButtonText("重置数据")
                .setWarning()
                .onClick(async () => {
                    if (!this.plugin.settings.accessToken) {
                        new Notice("请先进行 OAuth 认证");
                        return;
                    }

                    if (confirm("确定要重置任务数据吗？\n\n该操作将：\n- 清空本地任务数据\n- 重新从滴答清单云端获取最新数据\n- 此操作不可逆")) {
                        this.plugin.settings.tasks = [];
                        await this.plugin.saveSettings();
                        await this.plugin.syncManager.syncFromDidaList();
                    }
                }));
    }
}
