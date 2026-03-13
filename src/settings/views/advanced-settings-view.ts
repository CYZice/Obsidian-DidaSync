import { App, Notice, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";

export class AdvancedSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "自动清理设置" });
        const cleanInfo = containerEl.createDiv();
        cleanInfo.style.cssText = "padding: 10px; border-radius: 5px; margin: 10px 0; color: #6c757d;";
        cleanInfo.innerHTML = "<strong>说明：</strong>启用自动清理功能后，插件会在每次启动时（延迟30秒）自动清理指定时间之前的已完成任务数据，以保持数据文件的整洁。此操作仅清理本地数据，不会影响滴答清单云端数据。";

        new Setting(containerEl).setName("自动清理已完成任务").setDesc("启用后会在插件启动时自动清理指定时间之前的已完成任务数据").addToggle(t => t.setValue(this.plugin.settings.autoCleanCompletedTasks).onChange(async t => {
            this.plugin.settings.autoCleanCompletedTasks = t;
            await this.plugin.saveSettings();
        }));

        new Setting(containerEl).setName("清理间隔").setDesc("自动清理已完成任务的时间间隔（月数）").addDropdown(e => {
            for (let t = 1; t <= 12; t++) e.addOption(t.toString(), t + "个月");
            e.setValue(this.plugin.settings.autoCleanInterval.toString()).onChange(async t => {
                this.plugin.settings.autoCleanInterval = parseInt(t);
                await this.plugin.saveSettings();
            });
        });

        containerEl.createEl("h3", { text: "数据重置" });
        const resetInfo = containerEl.createDiv();
        resetInfo.style.cssText = "padding: 10px; border-radius: 5px; margin: 10px 0; color: #856404; border: 1px solid #ffeaa7;";
        resetInfo.innerHTML = "<strong>⚠️ 警告：</strong>此操作将完全清空本地任务数据，并从滴答清单云端重新获取最新数据。此操作不可逆，建议备份仓库后使用。(适用于Obsidian本地任务数据已经破坏、异常等情况）";

        new Setting(containerEl).setName("重置任务数据").setDesc("清空本地任务数据,并重新从云端获取任务到你的Obsidian").addButton(t => t.setButtonText("重置数据").setWarning().onClick(async () => {
            if (this.plugin.settings.accessToken) {
                if (confirm('确定要重置任务数据吗？\n\n此操作将：\n• 完全清空本地任务数据\n• 重新从滴答清单云端获取数据\n• 此操作不可逆\n\n点击"确定"继续，点击"取消"放弃操作。')) {
                    this.plugin.settings.tasks = [];
                    await this.plugin.saveSettings();
                    await this.plugin.syncManager.syncFromDidaList();
                }
            } else {
                new Notice("请先进行OAuth认证");
            }
        }));
    }
}
