import { App, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";

export class SyncSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "同步设置" });
        new Setting(containerEl).setName("自动同步").setDesc("启用后会定期从滴答清单同步任务").addToggle(t => t.setValue(this.plugin.settings.autoSync).onChange(async t => {
            this.plugin.settings.autoSync = t;
            await this.plugin.saveSettings();
            this.plugin.syncManager.setupAutoSync();
        }));

        new Setting(containerEl).setName("显示归档项目").setDesc("选择是否在任务清单中显示已归档的项目").addDropdown(t => t.addOption("false", "隐藏归档项目").addOption("true", "显示归档项目").setValue(this.plugin.settings.showArchivedProjects.toString()).onChange(async t => {
            this.plugin.settings.showArchivedProjects = "true" === t;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
        }));

        new Setting(containerEl).setName("同步间隔").setDesc("自动从滴答清单同步的间隔时间（分钟）").addSlider(t => t.setLimits(5, 120, 5).setValue(this.plugin.settings.syncInterval).setDynamicTooltip().onChange(async t => {
            this.plugin.settings.syncInterval = t;
            await this.plugin.saveSettings();
            this.plugin.syncManager.setupAutoSync();
        }));

        new Setting(containerEl).setName("手动同步").setDesc("立即执行双向同步").addButton(t => t.setButtonText("开始同步").onClick(async () => {
            await this.plugin.manualSync();
        }));

        containerEl.createEl("h3", { text: "原生任务同步设置" });
        const nativeInfo = containerEl.createDiv();
        nativeInfo.style.cssText = "padding: 10px; border-radius: 5px; margin: 10px 0; color: #0066cc;";
        nativeInfo.innerHTML = '<strong>说明：</strong>原生任务同步功能支持手动同步Obsidian中的原生任务格式（- [ ] ）到滴答清单。启用后，输入"- [ ] "时会弹出操作菜单，可选择同步到滴答清单或添加到期日期。同步后会在任务后添加链接，方便跳转到滴答清单查看详情。';

        new Setting(containerEl).setName("启用原生任务同步").setDesc('启用后可以手动同步Obsidian原生任务格式到滴答清单，输入"- [ ] "时显示操作菜单').addToggle(t => t.setValue(this.plugin.settings.enableNativeTaskSync).onChange(async t => {
            this.plugin.settings.enableNativeTaskSync = t;
            await this.plugin.saveSettings();
        }));

        containerEl.createEl("h3", { text: "日记同步设置" });
        const dailyInfo = containerEl.createDiv();
        dailyInfo.style.cssText = "padding: 10px; border-radius: 5px; margin: 10px 0; color: #0066cc;";
        dailyInfo.innerHTML = '<strong>说明：</strong>日记同步功能允许你通过命令将今天的待办任务同步到日记中。';

        new Setting(containerEl)
            .setName('目标语法块标识')
            .setDesc('在此设置要更新的日记待办事项块的标题(包括Markdown前缀)')
            .addText(text => text
                .setPlaceholder('输入目标区块标识')
                .setValue(this.plugin.settings.dailySyncTargetBlockHeader)
                .onChange(async (value) => {
                    this.plugin.settings.dailySyncTargetBlockHeader = value;
                    await this.plugin.saveSettings();
                }));
    }
}
