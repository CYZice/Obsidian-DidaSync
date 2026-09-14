import { App, Setting } from "obsidian";
import DidaSyncPlugin from "../../main";
import { ProjectVisibilityModal } from "../../modals/ProjectVisibilityModal";
import { TaskNoteProjectPickerModal } from "../../modals/TaskNoteProjectPickerModal";
import { AbstractSettingsView } from "./abstract-settings-view";

export class SyncSettingsView extends AbstractSettingsView {
    constructor(app: App, plugin: DidaSyncPlugin) {
        super(app, plugin);
    }

    render(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: this.t("settings.sync.heading.basic") });

        new Setting(containerEl)
            .setName(this.t("settings.sync.autoSync.name"))
            .setDesc(this.t("settings.sync.autoSync.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                    this.plugin.setupAutoSync();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.sync.interval.name"))
            .setDesc(this.t("settings.sync.interval.desc"))
            .addSlider((slider) => slider
                .setLimits(5, 120, 5)
                .setValue(this.plugin.settings.syncInterval)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = value;
                    await this.plugin.saveSettings();
                    this.plugin.setupAutoSync();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.sync.manual.name"))
            .setDesc(this.t("settings.sync.manual.desc"))
            .addButton((button) => button
                .setButtonText(this.t("settings.sync.manual.button"))
                .onClick(async () => {
                    await this.plugin.manualSync();
                }));

        containerEl.createEl("h3", { text: this.t("settings.sync.heading.visibility") });

        new Setting(containerEl)
            .setName(this.t("settings.sync.showArchived.name"))
            .setDesc(this.t("settings.sync.showArchived.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("false", this.t("settings.sync.showArchived.hide"))
                .addOption("true", this.t("settings.sync.showArchived.show"))
                .setValue(this.plugin.settings.showArchivedProjects.toString())
                .onChange(async (value) => {
                    this.plugin.settings.showArchivedProjects = value === "true";
                    await this.plugin.saveSettings();
                    this.plugin.refreshTaskView();
                }));

        const configurableProjects = this.plugin.getAvailableProjectConfigs()
            .filter((project) => this.plugin.settings.showArchivedProjects || !project.isArchived)
            .filter((project) => !this.plugin.isInboxProject(project.id, project.name));
        const hiddenCount = configurableProjects
            .filter((project) => !this.plugin.isProjectVisible(project.id, project.name))
            .length;
        new Setting(containerEl)
            .setName(this.t("settings.sync.visibility.name"))
            .setDesc(this.t("settings.sync.visibility.desc", { hidden: hiddenCount, total: configurableProjects.length }))
            .addButton((button) => button
                .setButtonText(this.t("settings.sync.visibility.button"))
                .onClick(() => {
                    new ProjectVisibilityModal(this.app, this.plugin, () => {
                        containerEl.empty();
                        this.render(containerEl);
                    }).open();
                }));

        containerEl.createEl("h3", { text: this.t("settings.sync.heading.native") });

        const nativeInfo = containerEl.createDiv("dida-settings-info dida-settings-info--primary");
        nativeInfo.setText(this.t("settings.sync.nativeInfo"));

        new Setting(containerEl)
            .setName(this.t("settings.sync.nativeEnable.name"))
            .setDesc(this.t("settings.sync.nativeEnable.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableNativeTaskSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableNativeTaskSync = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl("h3", { text: this.t("settings.sync.heading.notes") });

        const didaNoteInfo = containerEl.createDiv("dida-settings-info dida-settings-info--primary");
        didaNoteInfo.setText(this.t("settings.sync.noteInfo"));

        new Setting(containerEl)
            .setName(this.t("settings.sync.noteEnable.name"))
            .setDesc(this.t("settings.sync.noteEnable.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableDidaNoteSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableDidaNoteSync = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshTaskView();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.sync.noteFolder.name"))
            .setDesc(this.t("settings.sync.noteFolder.desc"))
            .addText((text) => text
                .setPlaceholder("DidaNotes")
                .setValue(this.plugin.settings.didaNoteSyncFolder || "DidaNotes")
                .onChange(async (value) => {
                    this.plugin.settings.didaNoteSyncFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.sync.projects.name"))
            .setDesc(this.t("settings.sync.projects.desc", { count: (this.plugin.settings.didaNoteSyncProjectIds || []).length }))
            .addButton((button) => button
                .setButtonText(this.t("settings.sync.projects.button"))
                .onClick(() => {
                    new TaskNoteProjectPickerModal(
                        this.app,
                        this.plugin,
                        this.plugin.settings.didaNoteSyncProjectIds || [],
                        () => {
                            containerEl.empty();
                            this.render(containerEl);
                        },
                        {
                            title: this.t("settings.sync.notePicker.title"),
                            selectionLabel: this.t("settings.sync.notePicker.selectionLabel"),
                            getProjectKey: (project) => project.id || "",
                            getProjects: () => this.plugin.getNoteSyncProjectConfigs(),
                            saveSelection: async (keys) => {
                                this.plugin.settings.didaNoteSyncProjectIds = keys.filter(Boolean);
                                await this.plugin.saveSettings();
                                this.plugin.refreshTaskView();
                            }
                        }
                    ).open();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.sync.runNow.name"))
            .setDesc(this.t("settings.sync.runNow.desc"))
            .addButton((button) => button
                .setButtonText(this.t("settings.sync.runNow.button"))
                .onClick(async () => {
                    await this.plugin.syncDidaNotes();
                }));

        containerEl.createEl("h3", { text: this.t("settings.sync.heading.taskNote") });

        const noteSyncInfo = containerEl.createDiv("dida-settings-info dida-settings-info--primary");
        noteSyncInfo.setText(this.t("settings.sync.taskNoteInfo"));

        new Setting(containerEl)
            .setName(this.t("settings.sync.blockHeader.name"))
            .setDesc(this.t("settings.sync.blockHeader.desc"))
            .addText((text) => text
                .setPlaceholder(this.t("settings.sync.blockHeader.placeholder"))
                .setValue(this.plugin.settings.taskNoteSyncTargetBlockHeader)
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncTargetBlockHeader = value;
                    await this.plugin.saveSettings();
                }));

        const rootFolderSetting = new Setting(containerEl)
            .setName(this.t("settings.sync.rootFolder.name"))
            .setDesc(this.t("settings.sync.rootFolder.desc"))
            .addText((text) => text
                .setPlaceholder("DidaSync")
                .setValue(this.plugin.settings.taskNoteSyncFolder || "DidaSync")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncFolder = value;
                    await this.plugin.saveSettings();
                    rootFolderPreview.setText(this.getTaskNoteRootFolderPreviewText());
                }));
        const rootFolderPreview = this.appendSettingPreview(rootFolderSetting, this.getTaskNoteRootFolderPreviewText());

        const dayPathSetting = new Setting(containerEl)
            .setName(this.t("settings.sync.dayPath.name"))
            .setDesc(this.t("settings.sync.pathDesc.plain"))
            .addText((text) => text
                .setPlaceholder(this.t("settings.sync.dayPath.placeholder"))
                .setValue(this.plugin.settings.taskNoteSyncPathPatterns?.day || "")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncPathPatterns.day = value;
                    await this.plugin.saveSettings();
                    dayPathPreview.setText(this.getTaskNotePathPreviewText("day"));
                }));
        const dayPathPreview = this.appendSettingPreview(dayPathSetting, this.getTaskNotePathPreviewText("day"));

        const weekPathSetting = new Setting(containerEl)
            .setName(this.t("settings.sync.weekPath.name"))
            .setDesc(this.t("settings.sync.weekPath.desc"))
            .addText((text) => text
                .setPlaceholder(this.t("settings.sync.weekPath.placeholder"))
                .setValue(this.plugin.settings.taskNoteSyncPathPatterns?.week || "")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncPathPatterns.week = value;
                    await this.plugin.saveSettings();
                    weekPathPreview.setText(this.getTaskNotePathPreviewText("week"));
                }));
        const weekPathPreview = this.appendSettingPreview(weekPathSetting, this.getTaskNotePathPreviewText("week"));

        const monthPathSetting = new Setting(containerEl)
            .setName(this.t("settings.sync.monthPath.name"))
            .setDesc(this.t("settings.sync.pathDesc.plain"))
            .addText((text) => text
                .setPlaceholder(this.t("settings.sync.monthPath.placeholder"))
                .setValue(this.plugin.settings.taskNoteSyncPathPatterns?.month || "")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncPathPatterns.month = value;
                    await this.plugin.saveSettings();
                    monthPathPreview.setText(this.getTaskNotePathPreviewText("month"));
                }));
        const monthPathPreview = this.appendSettingPreview(monthPathSetting, this.getTaskNotePathPreviewText("month"));

        const yearPathSetting = new Setting(containerEl)
            .setName(this.t("settings.sync.yearPath.name"))
            .setDesc(this.t("settings.sync.yearPath.desc"))
            .addText((text) => text
                .setPlaceholder("YYYY")
                .setValue(this.plugin.settings.taskNoteSyncPathPatterns?.year || "")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncPathPatterns.year = value;
                    await this.plugin.saveSettings();
                    yearPathPreview.setText(this.getTaskNotePathPreviewText("year"));
                }));
        const yearPathPreview = this.appendSettingPreview(yearPathSetting, this.getTaskNotePathPreviewText("year"));

        new Setting(containerEl)
            .setName(this.t("settings.sync.createNew.name"))
            .setDesc(this.t("settings.sync.createNew.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.taskNoteSyncCreateNewFile)
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncCreateNewFile = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.sync.weekStart.name"))
            .setDesc(this.t("settings.sync.weekStart.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("monday", this.t("settings.sync.weekStart.monday"))
                .addOption("sunday", this.t("settings.sync.weekStart.sunday"))
                .setValue(this.plugin.settings.taskNoteSyncWeekStart || "monday")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncWeekStart = value as "monday" | "sunday";
                    await this.plugin.saveSettings();
                    weekPathPreview.setText(this.getTaskNotePathPreviewText("week"));
                }));

        new Setting(containerEl)
            .setName(this.t("settings.sync.remoteQuery.name"))
            .setDesc(this.t("settings.sync.remoteQuery.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.taskNoteSyncUseRemoteQuery)
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncUseRemoteQuery = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(this.t("settings.sync.scope.name"))
            .setDesc(this.getTaskNoteProjectScopePreviewText())
            .addDropdown((dropdown) => dropdown
                .addOption("all", this.t("settings.sync.scope.all"))
                .addOption("visible", this.t("settings.sync.scope.visible"))
                .addOption("custom", this.t("settings.sync.scope.custom"))
                .setValue(this.plugin.settings.taskNoteSyncProjectScope || "all")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncProjectScope = value as "all" | "visible" | "custom";
                    await this.plugin.saveSettings();
                    containerEl.empty();
                    this.render(containerEl);
                }))
            .addButton((button) => {
                const isCustom = this.plugin.settings.taskNoteSyncProjectScope === "custom";
                button
                    .setButtonText(this.t("settings.sync.projects.button"))
                    .setDisabled(!isCustom)
                    .onClick(() => {
                        if (!isCustom) return;
                        new TaskNoteProjectPickerModal(
                            this.app,
                            this.plugin,
                            this.plugin.settings.taskNoteSyncProjectKeys || [],
                            () => {
                                containerEl.empty();
                                this.render(containerEl);
                            }
                        ).open();
                    });
            });
    }

    getTaskNoteProjectScopePreviewText(): string {
        const scope = this.plugin.settings.taskNoteSyncProjectScope || "all";
        if (scope === "all") return this.t("settings.sync.scope.previewAll");
        if (scope === "visible") {
            const visibleCount = this.plugin.getAvailableProjectConfigs()
                .filter((project) => this.plugin.settings.showArchivedProjects || !project.isArchived)
                .filter((project) => this.plugin.isProjectVisible(project.id, project.name))
                .length;
            return this.t("settings.sync.scope.previewVisible", { count: visibleCount });
        }
        const keys = Array.isArray(this.plugin.settings.taskNoteSyncProjectKeys)
            ? this.plugin.settings.taskNoteSyncProjectKeys
            : [];
        return this.t("settings.sync.scope.previewCustom", { count: keys.length });
    }

    getTaskNoteRootFolderPreview(): string {
        const rootFolder = (this.plugin.settings.taskNoteSyncFolder || "").trim();
        return rootFolder || "/";
    }

    getTaskNoteRootFolderPreviewText(): string {
        return this.t("settings.sync.preview", { path: this.getTaskNoteRootFolderPreview() });
    }

    getTaskNotePathPreviewText(rangeType: "day" | "week" | "month" | "year"): string {
        const exampleDate = "2026-01-19";
        const range = this.plugin.taskNoteSyncManager.createRange(rangeType, exampleDate);
        const preview = this.plugin.taskNoteSyncManager.buildRelativeTargetPath(range);
        return this.t("settings.sync.preview", { path: preview });
    }

    appendSettingPreview(setting: Setting, text: string): HTMLDivElement {
        return setting.descEl.createDiv({
            cls: "dida-settings-preview dida-settings-preview--muted",
            text
        });
    }
}
