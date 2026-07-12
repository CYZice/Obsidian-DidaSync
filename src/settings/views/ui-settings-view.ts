import { App, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { DEFAULT_SETTINGS } from "../../types";
import { normalizePomodoroPresetMinutes } from "../../utils";
import { AbstractSettingsView } from "./abstract-settings-view";

export class UISettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "主任务视图设置" });
        const defaultCalendarMode = this.plugin.settings.defaultCalendarMode === "month" || this.plugin.settings.defaultCalendarMode === "year" ? this.plugin.settings.defaultCalendarMode : "day";
        new Setting(containerEl).setName("默认日历粒度").setDesc("时间段视图打开时默认使用的日历粒度").addDropdown(t => t.addOption("day", "日").addOption("month", "月").addOption("year", "年").setValue(defaultCalendarMode).onChange(async t => {
            this.plugin.settings.defaultCalendarMode = t as any;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
        }));

        new Setting(containerEl).setName("默认显示已完成").setDesc("在日历视图中默认显示已完成任务，月视图按整月、年视图按全年刷新远端完成记录").addToggle(t => t.setValue(this.plugin.settings.defaultShowCompletedInCalendar === true).onChange(async value => {
            this.plugin.settings.defaultShowCompletedInCalendar = value;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
        }));
        new Setting(containerEl).setName("显示时间线入口").setDesc("桌面端在任务视图顶部显示时间线弹窗入口；移动端始终隐藏。").addToggle(t => t.setValue(this.plugin.settings.showTimelineEntry !== false).onChange(async value => {
            this.plugin.settings.showTimelineEntry = value;
            await this.plugin.saveSettings();
            this.plugin.updateOptionalEntryVisibility();
            this.plugin.refreshTaskView();
        }));
        new Setting(containerEl).setName("显示番茄钟入口").setDesc("桌面端在任务视图顶部显示番茄钟入口；移动端始终隐藏。").addToggle(t => t.setValue(this.plugin.settings.showPomodoroEntry !== false).onChange(async value => {
            this.plugin.settings.showPomodoroEntry = value;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
        }));
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

        const pomodoroHeading = containerEl.createDiv({ cls: "setting-item-heading" });
        pomodoroHeading.createDiv({ text: "番茄钟休息设置" });
        pomodoroHeading.createDiv({
            cls: "setting-item-description",
            text: "设置短休息和长休息的默认时长。修改后会应用到后续休息阶段；若当前停留在未开始的休息阶段，也会同步更新显示。"
        });

        new Setting(containerEl).setName("短休息时长").setDesc("每个专注番茄结束后的短休息时长（分钟）").addSlider(t =>
            t.setLimits(1, 15, 1)
                .setValue(this.plugin.settings.pomodoroSettings?.shortBreakMinutes || 5)
                .setDynamicTooltip()
                .onChange(async value => {
                    const current = this.plugin.settings.pomodoroSettings || { ...DEFAULT_SETTINGS.pomodoroSettings };
                    this.plugin.settings.pomodoroSettings = { ...current, shortBreakMinutes: value };
                    await this.plugin.saveSettings();
                    this.app.workspace.getLeavesOfType("dida-task-view").forEach((leaf) => {
                        const view: any = leaf.view;
                        if (view?.pomodoroState && view.pomodoroState.phase === "shortBreak" && !view.pomodoroState.isRunning) {
                            view.resetPomodoroPhase("shortBreak");
                            view.renderPomodoroPanel();
                            view.updatePomodoroUI();
                        }
                    });
                })
        );

        new Setting(containerEl).setName("长休息时长").setDesc("每 4 个专注番茄结束后的长休息时长（分钟）").addSlider(t =>
            t.setLimits(15, 30, 1)
                .setValue(this.plugin.settings.pomodoroSettings?.longBreakMinutes || 15)
                .setDynamicTooltip()
                .onChange(async value => {
                    const current = this.plugin.settings.pomodoroSettings || { ...DEFAULT_SETTINGS.pomodoroSettings };
                    const presets = normalizePomodoroPresetMinutes(
                        [...(current.longBreakPresetMinutes || []), value],
                        15,
                        30,
                        DEFAULT_SETTINGS.pomodoroSettings.longBreakPresetMinutes
                    );
                    this.plugin.settings.pomodoroSettings = {
                        ...current,
                        longBreakMinutes: value,
                        longBreakPresetMinutes: presets
                    };
                    await this.plugin.saveSettings();
                    this.app.workspace.getLeavesOfType("dida-task-view").forEach((leaf) => {
                        const view: any = leaf.view;
                        if (view?.pomodoroState && view.pomodoroState.phase === "longBreak" && !view.pomodoroState.isRunning) {
                            view.resetPomodoroPhase("longBreak");
                            view.renderPomodoroPanel();
                            view.updatePomodoroUI();
                        }
                    });
                })
        );
    }
}
