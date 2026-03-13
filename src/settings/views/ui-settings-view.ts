import { App, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { AbstractSettingsView } from "./abstract-settings-view";

export class UISettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "主任务视图设置" });
        new Setting(containerEl).setName("默认视图模式").setDesc("右侧边栏打开任务清单时默认显示的视图类型").addDropdown(t => t.addOption("task", "任务列表").addOption("timeblock", "时间段视图").setValue(this.plugin.settings.defaultViewMode || "task").onChange(async t => {
            this.plugin.settings.defaultViewMode = t as any;
            await this.plugin.saveSettings();
        }));

        new Setting(containerEl).setName("时间块每小时高度").setDesc("时间段视图中每小时的高度（像素），调整后需要切换视图才能生效").addSlider(t => t.setLimits(50, 100, 5).setValue(this.plugin.settings.timeBlockHourHeight || 80).setDynamicTooltip().onChange(async t => {
            this.plugin.settings.timeBlockHourHeight = t;
            await this.plugin.saveSettings();
            document.documentElement.style.setProperty("--dida-hour-height", t + "px");
        }));

        new Setting(containerEl).setName("时间段视图起始时间").setDesc("自定义设置时间段视图的起始时间（保持24小时刻度）").addDropdown(e => {
            for (let t = 0; t < 24; t++) {
                var i = t.toString().padStart(2, "0") + ":00";
                e.addOption(t.toString(), i);
            }
            e.setValue((this.plugin.settings.timeBlockStartHour || 0).toString()).onChange(async t => {
                this.plugin.settings.timeBlockStartHour = parseInt(t);
                await this.plugin.saveSettings();
                this.plugin.refreshTaskView();
            });
        });
    }
}
