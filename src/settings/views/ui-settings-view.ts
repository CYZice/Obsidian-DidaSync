import { App, Notice, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { DEFAULT_SETTINGS } from "../../types";
import { normalizePomodoroPresetMinutes } from "../../utils";
import { MessageKey, MessageParams } from "../../i18n";
import { AbstractSettingsView } from "./abstract-settings-view";

export class UISettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        const t = (key: MessageKey, params?: MessageParams) => this.t(key, params);
        new Setting(containerEl)
            .setName(t("settings.language.name"))
            .setDesc(t("settings.language.desc"))
            .addDropdown(dropdown => dropdown
                .addOption("auto", t("settings.language.auto"))
                .addOption("en", t("settings.language.en"))
                .addOption("zh", t("settings.language.zh"))
                .setValue(this.plugin.settings.uiLanguage || "auto")
                .onChange(async value => {
                    this.plugin.settings.uiLanguage = value as any;
                    await this.plugin.saveSettings();
                    new Notice(t("settings.language.reloadNotice"));
                }));
        containerEl.createEl("h3", { text: t("settings.views.sidebarHeading") });
        new Setting(containerEl).setName(t("settings.views.defaultViewMode.name")).setDesc(t("settings.views.defaultViewMode.desc")).addDropdown(d => d.addOption("task", t("settings.views.viewMode.task")).addOption("timeblock", t("settings.views.viewMode.timeblock")).setValue(this.plugin.settings.defaultViewMode || "task").onChange(async value => {
            this.plugin.settings.defaultViewMode = value as any;
            await this.plugin.saveSettings();
        }));
        new Setting(containerEl).setName(t("settings.views.showTimeline.name")).setDesc(t("settings.views.showTimeline.desc")).addToggle(toggle => toggle.setValue(this.plugin.settings.showTimelineEntry !== false).onChange(async value => {
            this.plugin.settings.showTimelineEntry = value;
            await this.plugin.saveSettings();
            this.plugin.updateOptionalEntryVisibility();
            this.plugin.refreshTaskView();
        }));
        new Setting(containerEl).setName(t("settings.views.showPomodoro.name")).setDesc(t("settings.views.showPomodoro.desc")).addToggle(toggle => toggle.setValue(this.plugin.settings.showPomodoroEntry !== false).onChange(async value => {
            this.plugin.settings.showPomodoroEntry = value;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
        }));

        containerEl.createEl("h3", { text: t("settings.views.calendarHeading") });
        const defaultCalendarMode = this.plugin.settings.defaultCalendarMode === "month" || this.plugin.settings.defaultCalendarMode === "year" ? this.plugin.settings.defaultCalendarMode : "day";
        new Setting(containerEl).setName(t("settings.views.calendarGranularity.name")).setDesc(t("settings.views.calendarGranularity.desc")).addDropdown(d => d.addOption("day", t("settings.views.calendarMode.day")).addOption("month", t("settings.views.calendarMode.month")).addOption("year", t("settings.views.calendarMode.year")).setValue(defaultCalendarMode).onChange(async value => {
            this.plugin.settings.defaultCalendarMode = value as any;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
        }));
        new Setting(containerEl).setName(t("settings.views.showCompleted.name")).setDesc(t("settings.views.showCompleted.desc")).addToggle(toggle => toggle.setValue(this.plugin.settings.defaultShowCompletedInCalendar === true).onChange(async value => {
            this.plugin.settings.defaultShowCompletedInCalendar = value;
            await this.plugin.saveSettings();
            this.plugin.refreshTaskView();
        }));
        new Setting(containerEl).setName(t("settings.views.hourHeight.name")).setDesc(t("settings.views.hourHeight.desc")).addSlider(slider => slider.setLimits(50, 100, 5).setValue(this.plugin.settings.timeBlockHourHeight || 80).setDynamicTooltip().onChange(async value => {
            this.plugin.settings.timeBlockHourHeight = value;
            await this.plugin.saveSettings();
            document.documentElement.style.setProperty("--dida-hour-height", value + "px");
        }));

        new Setting(containerEl).setName(t("settings.views.startHour.name")).setDesc(t("settings.views.startHour.desc")).addDropdown(dropdown => {
            for (let hour = 0; hour < 24; hour++) {
                const label = hour.toString().padStart(2, "0") + ":00";
                dropdown.addOption(hour.toString(), label);
            }
            dropdown.setValue((this.plugin.settings.timeBlockStartHour || 0).toString()).onChange(async value => {
                this.plugin.settings.timeBlockStartHour = parseInt(value);
                await this.plugin.saveSettings();
                this.plugin.refreshTaskView();
            });
        });

        const pomodoroHeading = containerEl.createDiv({ cls: "setting-item-heading" });
        pomodoroHeading.createDiv({ text: t("settings.views.pomodoroHeading") });
        pomodoroHeading.createDiv({
            cls: "setting-item-description",
            text: t("settings.views.pomodoroHeadingDesc")
        });

        new Setting(containerEl).setName(t("settings.views.shortBreak.name")).setDesc(t("settings.views.shortBreak.desc")).addSlider(slider =>
            slider.setLimits(1, 15, 1)
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

        new Setting(containerEl).setName(t("settings.views.longBreak.name")).setDesc(t("settings.views.longBreak.desc")).addSlider(slider =>
            slider.setLimits(15, 30, 1)
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
