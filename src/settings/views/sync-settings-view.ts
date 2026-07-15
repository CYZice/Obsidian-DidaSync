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
        containerEl.createEl("h3", { text: "基础同步" });

        new Setting(containerEl)
            .setName("自动同步")
            .setDesc("启用后会定期从滴答清单同步任务。")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                    this.plugin.setupAutoSync();
                }));

        new Setting(containerEl)
            .setName("同步间隔")
            .setDesc("自动同步间隔时间，单位为分钟。")
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
            .setName("手动同步任务")
            .setDesc("立即执行任务双向同步。")
            .addButton((button) => button
                .setButtonText("开始同步")
                .onClick(async () => {
                    await this.plugin.manualSync();
                }));

        containerEl.createEl("h3", { text: "清单显示" });

        new Setting(containerEl)
            .setName("显示归档清单")
            .setDesc("控制任务侧边栏和清单选择器是否显示已归档清单。")
            .addDropdown((dropdown) => dropdown
                .addOption("false", "隐藏归档清单")
                .addOption("true", "显示归档清单")
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
            .setName("清单显示")
            .setDesc(`收集箱固定显示；当前隐藏 ${hiddenCount} / ${configurableProjects.length} 个清单。`)
            .addButton((button) => button
                .setButtonText("管理清单显示")
                .onClick(() => {
                    new ProjectVisibilityModal(this.app, this.plugin, () => {
                        containerEl.empty();
                        this.render(containerEl);
                    }).open();
                }));

        containerEl.createEl("h3", { text: "Obsidian 原生任务同步" });

        const nativeInfo = containerEl.createDiv("dida-settings-info dida-settings-info--primary");
        nativeInfo.setText('启用后可将 Obsidian 原生任务格式（- [ ]）同步到滴答清单，并在任务行追加跳转链接。');

        new Setting(containerEl)
            .setName("启用原生任务同步")
            .setDesc('启用后，输入 "- [ ] " 时会显示操作菜单，可选择同步到滴答清单。')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableNativeTaskSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableNativeTaskSync = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl("h3", { text: "滴答笔记同步" });

        const didaNoteInfo = containerEl.createDiv("dida-settings-info dida-settings-info--primary");
        didaNoteInfo.setText("将所选清单中的滴答笔记同步到 Obsidian，并在本地与远程之间保持内容更新。");

        new Setting(containerEl)
            .setName("启用滴答笔记同步")
            .setDesc("启用后，可在侧边栏和命令面板中使用笔记同步功能。")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableDidaNoteSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableDidaNoteSync = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshTaskView();
                }));

        new Setting(containerEl)
            .setName("笔记保存位置")
            .setDesc("每条滴答笔记会同步为一个 Markdown 文件；留空时保存到仓库根目录。")
            .addText((text) => text
                .setPlaceholder("DidaNotes")
                .setValue(this.plugin.settings.didaNoteSyncFolder || "DidaNotes")
                .onChange(async (value) => {
                    this.plugin.settings.didaNoteSyncFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("同步清单")
            .setDesc(`仅同步所选清单中的笔记；当前已选择 ${(this.plugin.settings.didaNoteSyncProjectIds || []).length} 个清单。`)
            .addButton((button) => button
                .setButtonText("选择清单")
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
                            title: "选择滴答笔记同步清单",
                            selectionLabel: "笔记同步清单",
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
            .setName("立即执行笔记同步")
            .setDesc("立即同步所选清单中的笔记；如本地内容已更新，将自动同步到远程。")
            .addButton((button) => button
                .setButtonText("同步笔记")
                .onClick(async () => {
                    await this.plugin.syncDidaNotes();
                }));

        containerEl.createEl("h3", { text: "任务写入笔记" });

        const noteSyncInfo = containerEl.createDiv("dida-settings-info dida-settings-info--primary");
        noteSyncInfo.setText("将某日、某周、某月、某年或自定义时间段内的任务汇总写入笔记。");

        new Setting(containerEl)
            .setName("写入区块")
            .setDesc("任务会写入这个标题下；未找到时自动创建。支持普通标题或 callout，例如 > [!todo]。")
            .addText((text) => text
                .setPlaceholder("输入目标区块标题")
                .setValue(this.plugin.settings.taskNoteSyncTargetBlockHeader)
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncTargetBlockHeader = value;
                    await this.plugin.saveSettings();
                }));

        const rootFolderSetting = new Setting(containerEl)
            .setName("笔记保存位置")
            .setDesc("自动创建任务汇总笔记的根文件夹。留空则保存到仓库根目录。")
            .addText((text) => text
                .setPlaceholder("DidaSync")
                .setValue(this.plugin.settings.taskNoteSyncFolder || "DidaSync")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncFolder = value;
                    await this.plugin.saveSettings();
                    rootFolderPreview.setText(`当前预览：${this.getTaskNoteRootFolderPreview()}`);
                }));
        const rootFolderPreview = this.appendSettingPreview(rootFolderSetting, `当前预览：${this.getTaskNoteRootFolderPreview()}`);

        const dayPathSetting = new Setting(containerEl)
            .setName("日记路径模式")
            .setDesc("相对根文件夹的路径，可包含子文件夹。")
            .addText((text) => text
                .setPlaceholder("YYYY/日记/YYYY-MM-DD")
                .setValue(this.plugin.settings.taskNoteSyncPathPatterns?.day || "")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncPathPatterns.day = value;
                    await this.plugin.saveSettings();
                    dayPathPreview.setText(this.getTaskNotePathPreviewText("day"));
                }));
        const dayPathPreview = this.appendSettingPreview(dayPathSetting, this.getTaskNotePathPreviewText("day"));

        const weekPathSetting = new Setting(containerEl)
            .setName("周记路径模式")
            .setDesc("相对根文件夹的路径，可包含子文件夹。支持 gggg、ww，并跟随“一周开始于”设置。")
            .addText((text) => text
                .setPlaceholder("gggg/周记/[W]ww")
                .setValue(this.plugin.settings.taskNoteSyncPathPatterns?.week || "")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncPathPatterns.week = value;
                    await this.plugin.saveSettings();
                    weekPathPreview.setText(this.getTaskNotePathPreviewText("week"));
                }));
        const weekPathPreview = this.appendSettingPreview(weekPathSetting, this.getTaskNotePathPreviewText("week"));

        const monthPathSetting = new Setting(containerEl)
            .setName("月记路径模式")
            .setDesc("相对根文件夹的路径，可包含子文件夹。")
            .addText((text) => text
                .setPlaceholder("YYYY/月记/YYYY-MM")
                .setValue(this.plugin.settings.taskNoteSyncPathPatterns?.month || "")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncPathPatterns.month = value;
                    await this.plugin.saveSettings();
                    monthPathPreview.setText(this.getTaskNotePathPreviewText("month"));
                }));
        const monthPathPreview = this.appendSettingPreview(monthPathSetting, this.getTaskNotePathPreviewText("month"));

        const yearPathSetting = new Setting(containerEl)
            .setName("年记路径模式")
            .setDesc("相对根文件夹的路径。")
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
            .setName("默认每次生成新笔记")
            .setDesc("开启后每次都新建；关闭后优先写入同名笔记，不存在时再创建。")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.taskNoteSyncCreateNewFile)
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncCreateNewFile = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("一周开始于")
            .setDesc("影响周记的起止日期，以及 gggg / ww 的编号结果。")
            .addDropdown((dropdown) => dropdown
                .addOption("monday", "周一")
                .addOption("sunday", "周日")
                .setValue(this.plugin.settings.taskNoteSyncWeekStart || "monday")
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncWeekStart = value as "monday" | "sunday";
                    await this.plugin.saveSettings();
                    weekPathPreview.setText(this.getTaskNotePathPreviewText("week"));
                }));

        new Setting(containerEl)
            .setName("同步前查询远端任务")
            .setDesc("开启后先按时间范围查询滴答最新任务；关闭后仅使用本地缓存。")
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.taskNoteSyncUseRemoteQuery)
                .onChange(async (value) => {
                    this.plugin.settings.taskNoteSyncUseRemoteQuery = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("默认清单来源")
            .setDesc(this.getTaskNoteProjectScopePreviewText())
            .addDropdown((dropdown) => dropdown
                .addOption("all", "全部清单")
                .addOption("visible", "仅侧边栏可见清单")
                .addOption("custom", "自定义清单")
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
                    .setButtonText("选择清单")
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
        if (scope === "all") return "同步到笔记时默认包含全部清单。";
        if (scope === "visible") {
            const visibleCount = this.plugin.getAvailableProjectConfigs()
                .filter((project) => this.plugin.settings.showArchivedProjects || !project.isArchived)
                .filter((project) => this.plugin.isProjectVisible(project.id, project.name))
                .length;
            return `同步到笔记时默认包含侧边栏可见清单（${visibleCount} 个）。`;
        }
        const keys = Array.isArray(this.plugin.settings.taskNoteSyncProjectKeys)
            ? this.plugin.settings.taskNoteSyncProjectKeys
            : [];
        return `同步到笔记时默认包含自定义清单（已选择 ${keys.length} 个）。`;
    }

    getTaskNoteRootFolderPreview(): string {
        const rootFolder = (this.plugin.settings.taskNoteSyncFolder || "").trim();
        return rootFolder || "/";
    }

    getTaskNotePathPreviewText(rangeType: "day" | "week" | "month" | "year"): string {
        const exampleDate = "2026-01-19";
        const range = this.plugin.taskNoteSyncManager.createRange(rangeType, exampleDate);
        const preview = this.plugin.taskNoteSyncManager.buildRelativeTargetPath(range);
        return `当前预览：${preview}`;
    }

    appendSettingPreview(setting: Setting, text: string): HTMLDivElement {
        return setting.descEl.createDiv({
            cls: "dida-settings-preview dida-settings-preview--muted",
            text
        });
    }
}
