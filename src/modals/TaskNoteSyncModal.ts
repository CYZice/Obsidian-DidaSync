import { App, Modal, Notice, Setting, TFile } from "obsidian";
import DidaSyncPlugin from "../main";
import {
    TaskNoteDidaBlockAnalysis,
    TaskNoteSyncRangeType
} from "../managers/TaskNoteSyncManager";
import { DidaSyncBlockConfig } from "../taskNoteBlock";
import { ProjectCatalogEntry } from "../types";
import { DatePickerModal } from "./DatePickerModal";
import { TaskNoteProjectPickerModal } from "./TaskNoteProjectPickerModal";

type TaskNoteSyncModalMode = "note" | "blocks";

export class TaskNoteSyncModal extends Modal {
    plugin: DidaSyncPlugin;
    sourceFile: TFile | null;
    targetFile: TFile | null = null;
    mode: TaskNoteSyncModalMode = "note";
    rangeType: TaskNoteSyncRangeType = "day";
    createNewFile = false;
    baseDate = "";
    startDate = "";
    endDate = "";
    projectScope: "all" | "visible" | "custom" = "all";
    selectedProjectKeys: string[] = [];
    previewEl: HTMLElement | null = null;
    blockAnalysis: TaskNoteDidaBlockAnalysis | null = null;
    selectedBlockIndex = -1;
    blockHeader = "> [!didasync]";
    blockRangeType: "day" | "custom" = "day";
    blockBaseDate = "";
    blockStartDate = "";
    blockEndDate = "";
    blockProjectScope: "all" | "custom" = "all";
    blockProjectKeys: string[] = [];

    constructor(app: App, plugin: DidaSyncPlugin, sourceFile: TFile | null = null) {
        super(app);
        this.plugin = plugin;
        this.sourceFile = sourceFile;
    }

    async onOpen() {
        this.modalEl.addClass("dida-task-note-sync-modal-shell");
        const today = this.plugin.taskNoteSyncManager.formatDateOnly(new Date());
        this.targetFile = this.sourceFile || this.app.workspace.getActiveFile();
        const targetContext = this.targetFile instanceof TFile
            ? await this.plugin.taskNoteSyncManager.resolveTargetContext(this.targetFile)
            : null;

        this.rangeType = targetContext?.rangeType || "day";
        this.baseDate = targetContext?.baseDate || today;
        this.startDate = targetContext?.startDate || this.baseDate;
        this.endDate = targetContext?.endDate || this.baseDate;
        this.createNewFile = this.plugin.settings.taskNoteSyncCreateNewFile;
        this.projectScope = this.plugin.settings.taskNoteSyncProjectScope || "all";
        this.selectedProjectKeys = Array.isArray(this.plugin.settings.taskNoteSyncProjectKeys)
            ? [...this.plugin.settings.taskNoteSyncProjectKeys]
            : [];
        this.blockAnalysis = await this.plugin.taskNoteSyncManager.analyzeDidaBlocksInFile(this.targetFile);
        if (this.blockAnalysis && this.blockAnalysis.totalBlocks > 0) this.mode = "blocks";
        this.initializeBlockForm();
        this.render();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("dida-task-note-sync-modal");
        contentEl.createEl("h3", { text: this.plugin.t("cmd.syncTasksToNote") });

        new Setting(contentEl)
            .setClass("dida-task-note-legacy-mode")
            .setName(this.plugin.t("taskNote.mode.name"))
            .setDesc(this.plugin.t("taskNote.mode.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("note", this.plugin.t("taskNote.mode.note"))
                .addOption("blocks", this.plugin.t("taskNote.mode.blocks"))
                .setValue(this.mode)
                .onChange((value) => {
                    this.mode = value as TaskNoteSyncModalMode;
                    this.render();
                }));

        this.renderModeTabs(contentEl);

        if (this.mode === "blocks") {
            this.renderBlockMode(contentEl);
        } else {
            this.renderNoteMode(contentEl);
        }

        const buttons = contentEl.createDiv("dida-calendar-buttons");
        buttons.createEl("button", { text: this.plugin.t("common.cancel") }).onclick = () => this.close();
        const syncButton = buttons.createEl("button", {
            text: this.mode === "blocks" ? this.plugin.t("taskNote.submitBlocks") : this.plugin.t("taskNote.submitNote"),
            cls: "mod-cta"
        });
        if (this.mode === "blocks" && !this.canSyncBlocks()) {
            syncButton.disabled = true;
        }
        syncButton.onclick = async () => {
            if (this.mode === "blocks") {
                if (!(this.targetFile instanceof TFile) || !this.canSyncBlocks()) return;
                this.close();
                await this.plugin.taskNoteSyncManager.syncDidaBlocksInFile(this.targetFile);
                return;
            }

            const range = this.buildRange();
            if (!range) return;
            if (this.projectScope === "custom" && this.selectedProjectKeys.length === 0) {
                new Notice(this.plugin.t("modal.projectPicker.requireOne"));
                return;
            }
            this.close();
            await this.plugin.taskNoteSyncManager.syncTasksToNote({
                range,
                createNewFile: this.createNewFile,
                projectScope: this.projectScope,
                projectKeys: this.getSelectedProjectKeysForSync()
            });
        };
    }

    renderModeTabs(contentEl: HTMLElement) {
        const tabs = contentEl.createDiv("dida-task-note-mode-tabs");
        const options: Array<{ mode: TaskNoteSyncModalMode; label: string; desc: string }> = [
            { mode: "note", label: this.plugin.t("taskNote.tab.noteLabel"), desc: this.plugin.t("taskNote.tab.noteDesc") },
            { mode: "blocks", label: this.plugin.t("taskNote.tab.blocksLabel"), desc: this.plugin.t("taskNote.tab.blocksDesc") }
        ];
        options.forEach((option) => {
            const tab = tabs.createDiv({
                cls: `dida-task-note-mode-tab${this.mode === option.mode ? " is-active" : ""}`
            });
            tab.createDiv({ cls: "dida-task-note-mode-tab-label", text: option.label });
            tab.createDiv({ cls: "dida-task-note-mode-tab-desc", text: option.desc });
            tab.onclick = () => {
                if (this.mode === option.mode) return;
                this.mode = option.mode;
                this.render();
            };
        });
    }

    renderNoteMode(contentEl: HTMLElement) {
        new Setting(contentEl)
            .setName(this.plugin.t("taskNote.range.name"))
            .setDesc(this.plugin.t("taskNote.range.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("day", this.plugin.t("taskNote.range.day"))
                .addOption("week", this.plugin.t("taskNote.range.week"))
                .addOption("month", this.plugin.t("taskNote.range.month"))
                .addOption("year", this.plugin.t("taskNote.range.year"))
                .addOption("custom", this.plugin.t("taskNote.range.custom"))
                .setValue(this.rangeType)
                .onChange((value) => {
                    this.rangeType = value as TaskNoteSyncRangeType;
                    this.render();
                }));

        if (this.rangeType === "custom") {
            this.addDateInput(contentEl, this.plugin.t("taskNote.date.start"), this.startDate, (value) => {
                this.startDate = value;
                this.updatePreview();
            });
            this.addDateInput(contentEl, this.plugin.t("taskNote.date.end"), this.endDate, (value) => {
                this.endDate = value;
                this.updatePreview();
            });
        } else {
            this.addDateInput(contentEl, this.plugin.t("taskNote.date.base"), this.baseDate, (value) => {
                this.baseDate = value;
                this.updatePreview();
            });
        }

        new Setting(contentEl)
            .setName(this.plugin.t("taskNote.scope.name"))
            .setDesc(this.plugin.t("taskNote.scope.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("all", this.plugin.t("settings.sync.scope.all"))
                .addOption("visible", this.plugin.t("settings.sync.scope.visible"))
                .addOption("custom", this.plugin.t("settings.sync.scope.custom"))
                .setValue(this.projectScope)
                .onChange(async (value) => {
                    this.projectScope = value as "all" | "visible" | "custom";
                    this.plugin.settings.taskNoteSyncProjectScope = this.projectScope;
                    await this.plugin.saveSettings();
                    this.render();
                }));

        if (this.projectScope === "custom") {
            this.renderProjectPickerEntry(contentEl);
        }

        new Setting(contentEl)
            .setName(this.plugin.t("taskNote.newFile.name"))
            .setDesc(this.plugin.t("taskNote.newFile.desc"))
            .addToggle((toggle) => toggle
                .setValue(this.createNewFile)
                .onChange(async (value) => {
                    this.createNewFile = value;
                    this.plugin.settings.taskNoteSyncCreateNewFile = value;
                    await this.plugin.saveSettings();
                    this.updatePreview();
                }));

        this.previewEl = contentEl.createDiv("dida-task-note-summary-panel");
        this.updatePreview();
    }

    renderBlockMode(contentEl: HTMLElement) {
        const info = contentEl.createDiv("dida-settings-info dida-settings-info--primary dida-task-note-block-status");
        if (!(this.targetFile instanceof TFile)) {
            info.setText(this.plugin.t("taskNote.blocks.noMarkdown"));
            return;
        }

        if (!this.blockAnalysis) {
            info.setText(this.plugin.t("taskNote.blocks.currentFile", { path: this.targetFile.path }));
            return;
        }

        info.createDiv({ text: this.plugin.t("taskNote.blocks.currentFile", { path: this.blockAnalysis.file.path }) });
        info.createDiv({ text: this.plugin.t("taskNote.blocks.detected", { count: this.blockAnalysis.totalBlocks }) });
        info.createDiv({ text: this.plugin.t("taskNote.blocks.syncable", { valid: this.blockAnalysis.validBlocks, invalid: this.blockAnalysis.invalidBlocks }) });

        this.renderSummaryItem(info, this.plugin.t("taskNote.summary.currentFile"), this.blockAnalysis.file.path, "dida-task-note-summary-item--path");
        this.renderSummaryItem(info, this.plugin.t("taskNote.summary.blockCount"), `${this.blockAnalysis.totalBlocks}`);
        this.renderSummaryItem(info, this.plugin.t("taskNote.summary.syncable"), `${this.blockAnalysis.validBlocks}`);
        this.renderSummaryItem(info, this.plugin.t("taskNote.summary.invalid"), `${this.blockAnalysis.invalidBlocks}`, this.blockAnalysis.invalidBlocks > 0 ? "dida-task-note-summary-item--error" : "");

        const editorEl = contentEl.createDiv("dida-task-note-block-editor");
        this.renderBlockEditor(editorEl);

        if (this.blockAnalysis.totalBlocks > 0) this.renderBlockSummary(contentEl);
    }

    canSyncBlocks() {
        return !!this.blockAnalysis && this.blockAnalysis.validBlocks > 0 && this.targetFile instanceof TFile;
    }

    renderBlockEditor(contentEl: HTMLElement) {
        const analysis = this.blockAnalysis;
        new Setting(contentEl)
            .setName(this.plugin.t("taskNote.block.edit.name"))
            .setDesc(this.plugin.t("taskNote.block.edit.desc"))
            .addDropdown((dropdown) => {
                dropdown.addOption("-1", this.plugin.t("taskNote.block.new"));
                analysis?.items.forEach((item, index) => {
                    dropdown.addOption(String(index), this.plugin.t("taskNote.block.option", { index: index + 1, line: item.lineIndex + 1 }));
                });
                dropdown
                    .setValue(String(this.selectedBlockIndex))
                    .onChange((value) => {
                        this.selectedBlockIndex = Number(value);
                        this.loadBlockFormFromSelection();
                        this.render();
                    });
            });

        new Setting(contentEl)
            .setName(this.plugin.t("taskNote.block.title.name"))
            .setDesc(this.plugin.t("taskNote.block.title.desc"))
            .addDropdown((dropdown) => {
                const configured = (this.plugin.settings.taskNoteSyncTargetBlockHeader || "> [!todo]").trim();
                const headers = Array.from(new Set([configured, "> [!didasync]", this.blockHeader].filter(Boolean)));
                headers.forEach((header) => dropdown.addOption(header, header));
                dropdown
                    .setValue(this.blockHeader)
                    .onChange((value) => {
                        this.blockHeader = value;
                    });
            });

        new Setting(contentEl)
            .setName(this.plugin.t("taskNote.block.range.name"))
            .setDesc(this.plugin.t("taskNote.block.range.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("day", this.plugin.t("taskNote.range.day"))
                .addOption("custom", this.plugin.t("taskNote.range.custom"))
                .setValue(this.blockRangeType)
                .onChange((value) => {
                    this.blockRangeType = value as "day" | "custom";
                    this.render();
                }));

        if (this.blockRangeType === "custom") {
            this.addDateInput(contentEl, this.plugin.t("taskNote.date.blockStart"), this.blockStartDate, (value) => {
                this.blockStartDate = value;
            });
            this.addDateInput(contentEl, this.plugin.t("taskNote.date.blockEnd"), this.blockEndDate, (value) => {
                this.blockEndDate = value;
            });
        } else {
            this.addDateInput(contentEl, this.plugin.t("taskNote.date.blockBase"), this.blockBaseDate, (value) => {
                this.blockBaseDate = value;
                this.blockStartDate = value;
                this.blockEndDate = value;
            });
        }

        new Setting(contentEl)
            .setName(this.plugin.t("taskNote.block.scope.name"))
            .setDesc(this.plugin.t("taskNote.block.scope.desc"))
            .addDropdown((dropdown) => dropdown
                .addOption("all", this.plugin.t("settings.sync.scope.all"))
                .addOption("custom", this.plugin.t("settings.sync.scope.custom"))
                .setValue(this.blockProjectScope)
                .onChange((value) => {
                    this.blockProjectScope = value as "all" | "custom";
                    this.render();
                }));

        if (this.blockProjectScope === "custom") {
            new Setting(contentEl)
                .setName(this.plugin.t("taskNote.block.customProjects.name"))
                .setDesc(this.plugin.t("taskNote.block.customProjects.desc", { count: this.blockProjectKeys.length, preview: this.getBlockProjectPreviewText() }))
                .addButton((button) => button
                    .setButtonText(this.plugin.t("settings.sync.projects.button"))
                    .onClick(() => {
                        new TaskNoteProjectPickerModal(this.app, this.plugin, this.blockProjectKeys, (keys) => {
                            this.blockProjectKeys = keys;
                            this.render();
                        }).open();
                    }));
        }

        const preview = contentEl.createDiv("dida-task-note-config-preview");
        const blockConfig = this.buildBlockConfig();
        this.renderSummaryItem(preview, this.plugin.t("taskNote.summary.range"), blockConfig.range);
        this.renderSummaryItem(
            preview,
            this.plugin.t("taskNote.summary.projects"),
            blockConfig.projects.length > 0
                ? blockConfig.projects.map((name) => this.plugin.getProjectDisplayName(name)).join(this.plugin.t("taskNote.projectsJoin"))
                : this.plugin.t("settings.sync.scope.all")
        );
        this.renderSummaryItem(preview, this.plugin.t("taskNote.summary.writeConfig"), this.selectedBlockIndex >= 0 ? this.plugin.t("taskNote.block.updateExisting") : this.plugin.t("taskNote.block.insertNew"));
        preview.createDiv({ text: this.plugin.t("taskNote.block.configPreview", { json: JSON.stringify(this.buildBlockConfig()) }) });

        new Setting(contentEl)
            .addButton((button) => button
                .setButtonText(this.selectedBlockIndex >= 0 ? this.plugin.t("taskNote.block.save") : this.plugin.t("taskNote.block.insert"))
                .setCta()
                .onClick(async () => {
                    await this.saveBlockConfig();
                }));
    }

    renderBlockSummary(contentEl: HTMLElement) {
        const list = contentEl.createDiv("dida-task-note-block-list");
        this.blockAnalysis?.items.forEach((item, index) => {
            const row = list.createDiv(`dida-task-note-block-row${item.error ? " has-error" : ""}`);
            const main = row.createDiv("dida-task-note-block-row-main");
            const title = main.createDiv("dida-task-note-block-row-title");
            title.createSpan({ cls: "dida-task-note-block-row-index", text: this.plugin.t("taskNote.block.rowIndex", { index: index + 1 }) });
            title.createSpan({ cls: "dida-task-note-block-row-name", text: item.title || this.plugin.t("taskNote.block.unnamed") });
            main.createDiv({ cls: "dida-task-note-block-row-line", text: this.plugin.t("taskNote.block.rowLine", { line: item.lineIndex + 1 }) });
            const meta = row.createDiv("dida-task-note-block-row-meta");
            this.renderSummaryItem(meta, this.plugin.t("taskNote.summary.range"), item.rangeText);
            this.renderSummaryItem(meta, this.plugin.t("taskNote.summary.projects"), item.projectsText);
            if (item.error) this.renderSummaryItem(meta, this.plugin.t("taskNote.summary.error"), item.error, "dida-task-note-summary-item--error");
            row.createDiv({ text: this.plugin.t("taskNote.block.rowTitle", { index: index + 1, name: item.title || this.plugin.t("taskNote.block.unnamed") }) });
            row.createDiv({ text: this.plugin.t("taskNote.block.rowRange", { range: item.rangeText }) });
            row.createDiv({ text: this.plugin.t("taskNote.block.rowProjects", { projects: item.projectsText }) });
            if (item.error) row.createDiv({ text: this.plugin.t("taskNote.block.rowError", { message: item.error }) });
        });
    }

    initializeBlockForm() {
        const today = this.baseDate || this.plugin.taskNoteSyncManager.formatDateOnly(new Date());
        this.blockHeader = (this.plugin.settings.taskNoteSyncTargetBlockHeader || "> [!didasync]").trim();
        this.blockRangeType = "day";
        this.blockBaseDate = today;
        this.blockStartDate = today;
        this.blockEndDate = today;
        this.blockProjectScope = "all";
        this.blockProjectKeys = [];
        if (this.blockAnalysis && this.blockAnalysis.items.length > 0) {
            this.selectedBlockIndex = 0;
            this.loadBlockFormFromSelection();
        }
    }

    loadBlockFormFromSelection() {
        const item = this.blockAnalysis?.items.find((candidate) => candidate.blockIndex === this.selectedBlockIndex);
        if (!item) {
            this.selectedBlockIndex = -1;
            this.blockHeader = (this.plugin.settings.taskNoteSyncTargetBlockHeader || "> [!didasync]").trim();
            return;
        }

        this.blockHeader = item.header || this.blockHeader;
        const rawRange = item.config.range || this.blockBaseDate;
        const rangeParts = rawRange.split("~").map((part) => part.trim()).filter(Boolean);
        const hasValidRangeStart = /^\d{4}-\d{2}-\d{2}$/.test(rangeParts[0] || "");
        const range = hasValidRangeStart
            ? this.plugin.taskNoteSyncManager.createRange(
                rangeParts.length > 1 ? "custom" : "day",
                rangeParts[0],
                rangeParts[1]
            )
            : this.plugin.taskNoteSyncManager.createRange("day", this.blockBaseDate);
        this.blockRangeType = range.startDate === range.endDate ? "day" : "custom";
        this.blockBaseDate = range.startDate;
        this.blockStartDate = range.startDate;
        this.blockEndDate = range.endDate;
        this.blockProjectKeys = (item.config.projects || []).map((project) => this.getProjectFilterKeyForConfigProject(project));
        this.blockProjectScope = this.blockProjectKeys.length > 0 ? "custom" : "all";
    }

    buildBlockConfig(): DidaSyncBlockConfig {
        const range = this.blockRangeType === "custom"
            ? this.plugin.taskNoteSyncManager.createRange("custom", this.blockStartDate, this.blockEndDate)
            : this.plugin.taskNoteSyncManager.createRange("day", this.blockBaseDate);
        return {
            range: range.startDate === range.endDate ? range.startDate : `${range.startDate}~${range.endDate}`,
            projects: this.blockProjectScope === "custom" ? this.getBlockProjectNamesForConfig() : []
        };
    }

    async saveBlockConfig() {
        if (!(this.targetFile instanceof TFile)) {
            new Notice(this.plugin.t("taskNote.requireMarkdown"));
            return;
        }
        if (this.blockProjectScope === "custom" && this.blockProjectKeys.length === 0) {
            new Notice(this.plugin.t("modal.projectPicker.requireOne"));
            return;
        }
        this.blockAnalysis = await this.plugin.taskNoteSyncManager.saveDidaBlockConfigInFile(this.targetFile, {
            blockIndex: this.selectedBlockIndex >= 0 ? this.selectedBlockIndex : undefined,
            header: this.blockHeader,
            config: this.buildBlockConfig()
        });
        if (this.selectedBlockIndex < 0 && this.blockAnalysis) {
            this.selectedBlockIndex = Math.max(0, this.blockAnalysis.items.length - 1);
        }
        this.loadBlockFormFromSelection();
        this.render();
    }

    getBlockProjectNamesForConfig(): string[] {
        return this.blockProjectKeys.map((key) => this.getProjectNameForFilterKey(key));
    }

    getBlockProjectPreviewText(): string {
        if (this.blockProjectKeys.length === 0) return this.plugin.t("taskNote.noneSelected");
        return this.getBlockProjectNamesForConfig()
            .map((name) => this.plugin.getProjectDisplayName(name))
            .join(this.plugin.t("taskNote.projectsJoin"));
    }

    getProjectNameForFilterKey(key: string): string {
        const projects = this.getProjectOptions();
        const matched = projects.find((project) =>
            this.plugin.getProjectFilterKeyAliases(project.id, project.name).includes(this.normalizeConfigProjectKey(key))
        );
        if (matched?.name) return matched.name;
        if (key.startsWith("name:")) return key.substring(5);
        return key;
    }

    getProjectFilterKeyForConfigProject(projectKey: string): string {
        const normalized = this.normalizeConfigProjectKey(projectKey);
        const matched = this.getProjectOptions().find((project) =>
            this.plugin.getProjectFilterKeyAliases(project.id, project.name).includes(normalized)
        );
        return matched ? this.plugin.getProjectFilterKey(matched.id, matched.name) : normalized;
    }

    normalizeConfigProjectKey(projectKey: string): string {
        const trimmed = (projectKey || "").trim();
        return /^(id|name):/.test(trimmed) ? trimmed : `name:${trimmed}`;
    }

    addDateInput(containerEl: HTMLElement, name: string, value: string, onChange: (value: string) => void) {
        new Setting(containerEl)
            .setName(name)
            .addButton((button) => {
                button.setIcon("calendar");
                button.setButtonText(value || this.plugin.t("completed.chooseDate"));
                button.onClick(() => {
                    new DatePickerModal(
                        this.app,
                        value || null,
                        (date) => {
                            if (!date) return;
                            const nextValue = this.plugin.taskNoteSyncManager.formatDateOnly(date);
                            onChange(nextValue);
                            this.render();
                        },
                        button.buttonEl,
                        this.plugin,
                        null,
                        { dateOnly: true }
                    ).open();
                });
            });
    }

    renderProjectPickerEntry(containerEl: HTMLElement) {
        const projects = this.getProjectOptions();
        if (projects.length === 0) {
            const empty = containerEl.createDiv("dida-settings-info");
            empty.setText(this.plugin.t("modal.projectPicker.empty"));
            return;
        }

        new Setting(containerEl)
            .setName(this.plugin.t("settings.sync.scope.custom"))
            .setDesc(this.plugin.t("taskNote.projectsCount", { selected: this.selectedProjectKeys.length, total: projects.length }))
            .addButton((button) => button
                .setButtonText(this.plugin.t("settings.sync.projects.button"))
                .onClick(() => {
                    new TaskNoteProjectPickerModal(this.app, this.plugin, this.selectedProjectKeys, (keys) => {
                        this.selectedProjectKeys = keys;
                        this.updatePreview();
                    }).open();
                }));
    }

    getProjectOptions(): ProjectCatalogEntry[] {
        return this.plugin.getAvailableProjectConfigs()
            .filter((project) => this.plugin.settings.showArchivedProjects || !project.isArchived);
    }

    getSelectedProjectKeysForSync() {
        if (this.projectScope === "all") return [];
        if (this.projectScope === "visible") {
            return this.getProjectOptions()
                .filter((project) => this.plugin.isProjectVisible(project.id, project.name))
                .map((project) => this.plugin.getProjectFilterKey(project.id, project.name));
        }
        return [...this.selectedProjectKeys];
    }

    buildRange() {
        if (this.rangeType === "custom") {
            if (!this.startDate || !this.endDate) {
                new Notice(this.plugin.t("taskNote.requireRange"));
                return null;
            }
            return this.plugin.taskNoteSyncManager.createRange("custom", this.startDate, this.endDate);
        }

        if (!this.baseDate) {
            new Notice(this.plugin.t("taskNote.requireBaseDate"));
            return null;
        }
        return this.plugin.taskNoteSyncManager.createRange(this.rangeType, this.baseDate);
    }

    renderSummaryItem(containerEl: HTMLElement, label: string, value: string, extraClass: string = "") {
        const item = containerEl.createDiv({ cls: `dida-task-note-summary-item ${extraClass}`.trim() });
        item.createDiv({ cls: "dida-task-note-summary-label", text: label });
        item.createDiv({ cls: "dida-task-note-summary-value", text: value });
    }

    updatePreview() {
        if (!this.previewEl) return;
        if (this.rangeType === "custom" && (!this.startDate || !this.endDate)) {
            this.previewEl.setText(this.plugin.t("taskNote.invalidDate"));
            return;
        }
        if (this.rangeType !== "custom" && !this.baseDate) {
            this.previewEl.setText(this.plugin.t("taskNote.invalidDate"));
            return;
        }

        const range = this.rangeType === "custom"
            ? this.plugin.taskNoteSyncManager.createRange("custom", this.startDate, this.endDate)
            : this.plugin.taskNoteSyncManager.createRange(this.rangeType, this.baseDate);

        const filePath = this.plugin.taskNoteSyncManager.buildTargetFilePath(range);
        const fileMode = this.createNewFile ? this.plugin.t("taskNote.file.newFile") : this.plugin.t("taskNote.file.reuse");
        const projectLabel = this.getProjectScopePreviewText();
        this.previewEl.empty();
        this.renderSummaryItem(this.previewEl, this.plugin.t("taskNote.summary.taskRange"), this.plugin.t("taskNote.taskRangeValue", { start: range.startDate, end: range.endDate }));
        this.renderSummaryItem(this.previewEl, this.plugin.t("taskNote.summary.scope"), projectLabel);
        this.renderSummaryItem(this.previewEl, this.plugin.t("taskNote.summary.writeMode"), fileMode);
        this.renderSummaryItem(this.previewEl, this.plugin.t("taskNote.summary.target"), filePath, "dida-task-note-summary-item--path");
        this.previewEl.createDiv({ text: this.plugin.t("taskNote.summary.taskRange") + ": " + this.plugin.t("taskNote.taskRangeValue", { start: range.startDate, end: range.endDate }) });
        this.previewEl.createDiv({ text: this.plugin.t("taskNote.summary.scope") + ": " + projectLabel });
        this.previewEl.createDiv({ text: this.plugin.t("taskNote.summary.writeMode") + ": " + fileMode });
        this.previewEl.createDiv({ text: this.plugin.t("taskNote.summary.target") + ": " + filePath });
    }

    getProjectScopePreviewText() {
        if (this.projectScope === "all") return this.plugin.t("settings.sync.scope.all");
        const keys = this.getSelectedProjectKeysForSync();
        if (this.projectScope === "visible") return this.plugin.t("taskNote.scope.visibleCount", { count: keys.length });
        const names = this.getProjectOptions()
            .filter((project) => keys.includes(this.plugin.getProjectFilterKey(project.id, project.name)))
            .map((project) => this.plugin.getProjectDisplayName(project.name));
        return names.length > 0 ? names.join(this.plugin.t("taskNote.projectsJoin")) : this.plugin.t("taskNote.noneSelected");
    }

    onClose() {
        this.contentEl.empty();
    }
}
