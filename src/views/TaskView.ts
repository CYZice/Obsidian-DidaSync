import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import DidaSyncPlugin from '../main';
import { Menu, Platform } from 'obsidian';
import { DatePickerModal } from '../modals/DatePickerModal';
import { AddTaskModal } from '../modals/AddTaskModal';
import { getCalendarCompletedFetchDecision, hasCalendarCompletedCacheForRange } from '../calendarCompletedFetch';
import { buildCalendarMonthGrid, CalendarMode, dedupeCalendarTasks, getCalendarDateKey, getCalendarMonthRange, getCalendarYearRange, groupTasksByCalendarDate } from '../calendarMonth';
import { resolveTaskIndex } from '../taskIndex';
import { formatTaskLine, formatTaskLineFromTask, parseTaskLine } from '../taskLineFormat';
import { buildDidaTaskDragPayload, buildDidaTaskFilterSets, buildDidaTaskTreeIndex, getDidaTaskPath, getDidaTaskTreeKey, getDidaTaskTreeKeys, resolveDidaTaskCollapsedState, sortDidaTasksForTree } from '../taskTree';
import { CompletedTasksQuery, DEFAULT_SETTINGS, DidaNoteSyncRecord, DidaNoteSyncRunState, DidaTask } from '../types';
import { clampMinutes, dateAtMinutes, getTimeGridDay, getTimeGridRange, gridStartMinutes, isAllDayTimeGridTask, snapDuration, snapMinutes, taskBelongsToTimeGridDate, TIME_GRID_STEP_MINUTES } from '../timeGrid';
import { appendValidatedSvg, compareProjectGroups, debounce, getTimerRemainingSeconds, normalizePomodoroCompletionHistory, normalizePomodoroPresetMinutes, setIconElement, setTextWithIcon, translateRepeatFlag } from '../utils';

export const TASK_VIEW_TYPE = "dida-task-view";

export class TaskView extends ItemView {
    plugin: DidaSyncPlugin;
    searchQuery: string;
    taskStatusFilter: "active" | "completed";
    completedDateFilter: "last7" | "last30" | "last90";
    isComposing: boolean;
    viewMode: string;
    debouncedSearch: (query: string) => void;
    dateFilter: string | null;
    eventCleanupHandlers: (() => void)[];
    selectedDate: Date | null;
    calendarMode: CalendarMode;
    showCompletedInCalendar: boolean;
    calendarDisplayDate: Date;
    calendarCompletedLoading: boolean;
    calendarCompletedMonthKey: string;
    calendarCompletedError: string;
    lastOpenTaskItem: HTMLElement | null = null;
    isPomodoroVisible: boolean;
    pomodoroInterval: number | null;
    pomodoroTargetEndAt: number | null;
    pomodoroAudioContext: AudioContext | null;
    pomodoroAudioNodes: AudioNode[];
    pomodoroElements: any;
    isPomodoroDurationPickerVisible: boolean;
    isPomodoroCustomInputVisible: boolean;
    pomodoroCustomMinutes: string;
    pomodoroTrendPeriod: "week" | "month" | "year";
    pomodoroState: any;
    pomodoroToggleBtn: HTMLButtonElement | null = null;
    pomodoroHostEl: HTMLElement | null = null;
    completedTasksQuery: CompletedTasksQuery;
    completedTasksLoading: boolean;
    completedTasksError: string;

    constructor(leaf: WorkspaceLeaf, plugin: DidaSyncPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.searchQuery = "";
        this.taskStatusFilter = "active";
        this.completedDateFilter = "last7";
        this.isComposing = false;
        this.viewMode = "task";
        this.isPomodoroVisible = false;
        this.pomodoroInterval = null;
        this.pomodoroTargetEndAt = null;
        this.pomodoroAudioContext = null;
        this.pomodoroAudioNodes = [];
        this.pomodoroElements = {};
        this.isPomodoroDurationPickerVisible = false;
        this.isPomodoroCustomInputVisible = false;
        this.pomodoroCustomMinutes = "";
        this.pomodoroTrendPeriod = "week";
        this.dateFilter = null;
        this.eventCleanupHandlers = [];
        this.selectedDate = null;
        this.calendarMode = plugin.settings.defaultCalendarMode === "month" || plugin.settings.defaultCalendarMode === "year"
            ? plugin.settings.defaultCalendarMode
            : "day";
        this.showCompletedInCalendar = plugin.settings.defaultShowCompletedInCalendar === true;
        this.calendarDisplayDate = new Date();
        this.calendarCompletedLoading = false;
        this.calendarCompletedMonthKey = "";
        this.calendarCompletedError = "";
        this.completedTasksQuery = {
            ...this.plugin.buildDefaultCompletedTaskQuery(),
            ...(this.plugin.settings.completedTasksQuery || {})
        };
        this.completedTasksLoading = false;
        this.completedTasksError = "";

        this.initializePomodoroState();

        this.debouncedSearch = debounce((query: string) => {
            if (this.searchQuery !== query) {
                this.searchQuery = query;
                this.renderTaskList({
                    preserveSearch: true
                });
            }
        }, 300);
    }

    private resolveTaskOriginalIndex(task: { id?: string; didaId?: string | null; originalIndex?: number }) {
        return resolveTaskIndex(
            this.plugin.settings.tasks,
            task,
            typeof task.originalIndex === "number" ? task.originalIndex : undefined
        );
    }

    private getTaskChildTasks(task: DidaTask): DidaTask[] {
        const parentKeys = new Set(getDidaTaskTreeKeys(task));
        return this.plugin.settings.tasks.filter((candidate) => !!candidate.parentId && parentKeys.has(candidate.parentId));
    }

    private async toggleTaskChildrenCollapsed(task: DidaTask) {
        const taskKey = getDidaTaskTreeKey(task);
        if (!taskKey) return;
        const childTasks = this.getTaskChildTasks(task);
        if (childTasks.length === 0) return;
        const nextCollapsed = !resolveDidaTaskCollapsedState(task, childTasks.length, this.plugin.settings.childTaskCollapsedStates);
        this.plugin.settings.childTaskCollapsedStates = {
            ...(this.plugin.settings.childTaskCollapsedStates || {}),
            [taskKey]: nextCollapsed
        };
        await this.plugin.saveSettings();
        this.renderTaskList({ preserveSearch: true });
    }

    private renderChildCountControl(element: HTMLElement, completedCount: number, totalCount: number, collapsed: boolean, interactive: boolean) {
        element.empty();
        element.classList.toggle("is-collapsed", collapsed);
        element.classList.toggle("is-interactive", interactive);
        element.classList.toggle("dida-child-task-count-static", !interactive);
        element.setAttribute("data-collapsed", collapsed ? "true" : "false");

        const branchIcon = element.createSpan({ cls: "dida-child-task-count-icon" });
        setIconElement(branchIcon, "git-branch-plus");

        element.createSpan({
            cls: "dida-child-task-count-label",
            text: `${completedCount}/${totalCount}`
        });

        if (interactive) {
            const chevron = element.createSpan({ cls: "dida-child-task-count-chevron" });
            setIconElement(chevron, collapsed ? "chevron-right" : "chevron-down");
        }
    }

    private getTaskPathLabel(task: DidaTask): string {
        try {
            return getDidaTaskPath(task, this.plugin.settings.tasks || []);
        } catch (error) {
            return task.title || "未命名任务";
        }
    }

    private getTaskParentLabel(task: DidaTask): string {
        if (!task.parentId) return "";
        const path = this.getTaskPathLabel(task)
            .split(" / ")
            .map((part) => part.trim())
            .filter(Boolean);
        path.pop();
        return path.join(" / ");
    }

    initializePomodoroState() {
        const settings = this.getPomodoroSettings();
        this.pomodoroState = {
            phase: "focus",
            isRunning: false,
            remainingSeconds: 60 * settings.focusMinutes,
            durationSeconds: 60 * settings.focusMinutes,
            cycleFocusCount: 0
        };
    }

    getPomodoroSettings() {
        const settings = this.plugin.settings.pomodoroSettings || {};
        const merged = { ...DEFAULT_SETTINGS.pomodoroSettings, ...settings };
        merged.completionHistory = normalizePomodoroCompletionHistory(merged.completionHistory);
        return merged;
    }

    async updatePomodoroSettings(update: any) {
        const next = { ...this.getPomodoroSettings(), ...update };
        next.completionHistory = normalizePomodoroCompletionHistory(next.completionHistory);
        this.plugin.settings.pomodoroSettings = next;
        await this.plugin.saveSettings();
    }

    getPomodoroDateKey(date: Date = new Date()) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    getPomodoroCompletionHistory() {
        const history = this.getPomodoroSettings().completionHistory;
        return history && typeof history === "object" ? history : {};
    }

    getTodayPomodoroStats() {
        const key = this.getPomodoroDateKey();
        return this.getPomodoroCompletionHistory()[key] || { sessions: 0, minutes: 0 };
    }

    async recordPomodoroCompletion(minutes: number) {
        const settings = this.getPomodoroSettings();
        const history = { ...this.getPomodoroCompletionHistory() };
        const key = this.getPomodoroDateKey();
        const stats = history[key] || { sessions: 0, minutes: 0 };
        history[key] = {
            sessions: (stats.sessions || 0) + 1,
            minutes: (stats.minutes || 0) + minutes
        };
        await this.updatePomodoroSettings({
            completionHistory: history,
            totalFocusSessions: (settings.totalFocusSessions || 0) + 1,
            totalFocusMinutes: (settings.totalFocusMinutes || 0) + minutes
        });
    }

    getPomodoroTrendData(period: "week" | "month" | "year" = this.pomodoroTrendPeriod) {
        const history = this.getPomodoroCompletionHistory();
        const now = new Date();
        const data: { label: string; minutes: number }[] = [];
        if (period === "year") {
            for (let i = 0; i < 12; i++) {
                const minutes = Object.entries(history).reduce((sum, [key, value]) => {
                    const date = new Date(`${key}T00:00:00`);
                    return date.getFullYear() === now.getFullYear() && date.getMonth() === i
                        ? sum + (value.minutes || 0)
                        : sum;
                }, 0);
                data.push({ label: `${i + 1}月`, minutes });
            }
        } else if (period === "month") {
            const year = now.getFullYear();
            const month = now.getMonth();
            const days = new Date(year, month + 1, 0).getDate();
            for (let i = 1; i <= days; i++) {
                const date = new Date(year, month, i);
                const stats = history[this.getPomodoroDateKey(date)] || { minutes: 0 };
                data.push({ label: String(i), minutes: stats.minutes || 0 });
            }
        } else {
            for (let i = 6; i >= 0; i--) {
                const date = new Date(now);
                date.setHours(0, 0, 0, 0);
                date.setDate(now.getDate() - i);
                const key = this.getPomodoroDateKey(date);
                const stats = history[key] || { minutes: 0 };
                data.push({
                    label: ["日", "一", "二", "三", "四", "五", "六"][date.getDay()],
                    minutes: stats.minutes || 0
                });
            }
        }
        return data;
    }

    getPomodoroTrendSectionTitle() {
        return "专注趋势";
    }

    getPomodoroTrendRangeLabel(period: "week" | "month" | "year" = this.pomodoroTrendPeriod) {
        return period === "month" ? "本月" : period === "year" ? "本年" : "本周";
    }

    getPomodoroTrendAxisLabel(
        item: { label: string; minutes: number },
        index: number,
        length: number,
        period: "week" | "month" | "year" = this.pomodoroTrendPeriod
    ) {
        if (period === "year") return index % 2 === 0 || index === length - 1 ? item.label : "";
        if (period !== "month") return item.label;
        const label = parseInt(item.label, 10);
        return label === 1 || label === length || label % 5 === 0 ? item.label : "";
    }

    buildPomodoroSmoothPath(points: { x: number; y: number }[]) {
        if (!points || points.length === 0) return "";
        if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        const xs = points.map((p) => p.x);
        const ys = points.map((p) => p.y);
        const slopes: number[] = [];
        const tangents = new Array(points.length).fill(0);
        for (let i = 0; i < points.length - 1; i++) {
            const dx = xs[i + 1] - xs[i];
            const dy = ys[i + 1] - ys[i];
            slopes.push(dx === 0 ? 0 : dy / dx);
        }
        tangents[0] = slopes[0];
        tangents[points.length - 1] = slopes[slopes.length - 1];
        for (let i = 1; i < points.length - 1; i++) {
            const prev = slopes[i - 1];
            const next = slopes[i];
            tangents[i] = prev === 0 || next === 0 || (prev > 0) !== (next > 0) ? 0 : (prev + next) / 2;
        }
        for (let i = 0; i < slopes.length; i++) {
            if (slopes[i] === 0) {
                tangents[i] = 0;
                tangents[i + 1] = 0;
            } else {
                const a = tangents[i] / slopes[i];
                const b = tangents[i + 1] / slopes[i];
                const h = Math.hypot(a, b);
                if (h > 3) {
                    const scale = 3 / h;
                    tangents[i] = scale * a * slopes[i];
                    tangents[i + 1] = scale * b * slopes[i];
                }
            }
        }
        let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const dx = p1.x - p0.x;
            const prevSlope = i > 0 ? slopes[i - 1] : slopes[i];
            const nextSlope = i < slopes.length - 1 ? slopes[i + 1] : slopes[i];
            const hasPrevSwitch = i > 0 && slopes[i - 1] !== 0 && slopes[i] !== 0 && (slopes[i - 1] > 0) !== (slopes[i] > 0);
            const hasNextSwitch = i < slopes.length - 1 && slopes[i] !== 0 && slopes[i + 1] !== 0 && (slopes[i] > 0) !== (slopes[i + 1] > 0);
            let c1 = dx / 3;
            let c2 = dx / 3;
            if (p0.y !== p1.y) {
                c1 = hasPrevSwitch ? 0.44 * dx : prevSlope !== 0 && slopes[i] !== 0 ? 0.36 * dx : c1;
                c2 = hasNextSwitch ? 0.44 * dx : nextSlope !== 0 && slopes[i] !== 0 ? 0.36 * dx : c2;
            }
            const x1 = p0.x + c1;
            const y1 = p0.y + tangents[i] * c1;
            const x2 = p1.x - c2;
            const y2 = p1.y - tangents[i + 1] * c2;
            path += ` C ${x1.toFixed(2)} ${y1.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)} ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
        }
        return path;
    }

    buildPomodoroTrendSvg(data: { label: string; minutes: number }[], period: "week" | "month" | "year" = this.pomodoroTrendPeriod) {
        const width = Math.max(period === "month" ? 220 : 320, data.length * (period === "month" ? 11 : 22));
        const availableWidth = width - 28;
        const step = data.length > 1 ? availableWidth / (data.length - 1) : availableWidth;
        const maxMinutes = Math.max(1, ...data.map((item) => item.minutes || 0));
        const points = data.map((item, index) => ({
            x: 14 + step * index,
            y: 118 - 76 * ((item.minutes || 0) / maxMinutes),
            minutes: item.minutes || 0,
            label: item.label
        }));
        const line = this.buildPomodoroSmoothPath(points);
        const area = `${line} L ${points[points.length - 1].x.toFixed(2)} 118 L ${points[0].x.toFixed(2)} 118 Z`;
        const dots = points.map((point) => `
            <circle
                cx="${point.x.toFixed(2)}"
                cy="${point.y.toFixed(2)}"
                r="2.5"
                class="dida-pomodoro-trend-dot"
                data-label="${point.label}"
                data-minutes="${point.minutes}"
            />
        `).join("");
        return {
            chartWidth: width,
            points,
            svg: `
            <svg class="dida-pomodoro-trend-svg" viewBox="0 0 ${width} 150" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                    <linearGradient id="dida-pomodoro-trend-gradient" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stop-color="rgba(92, 111, 247, 0.55)"></stop>
                        <stop offset="100%" stop-color="rgba(92, 111, 247, 0.02)"></stop>
                    </linearGradient>
                </defs>
                <path d="${area}" class="dida-pomodoro-trend-area"></path>
                <path d="${line}" class="dida-pomodoro-trend-line"></path>
                ${dots}
            </svg>
        `
        };
    }

    bindPomodoroTrendTooltip(container: HTMLElement) {
        const tooltip = container.querySelector(".dida-pomodoro-trend-tooltip") as HTMLElement | null;
        const dots = container.querySelectorAll(".dida-pomodoro-trend-dot");
        if (!tooltip || dots.length === 0) return;
        const handleEnter = (event: MouseEvent) => {
            const target = event.currentTarget as HTMLElement;
            const minutes = target.getAttribute("data-minutes") || "0";
            tooltip.textContent = `${minutes} 分钟`;
            tooltip.classList.add("is-visible");
            const bounds = container.getBoundingClientRect();
            const left = event.clientX - bounds.left;
            const top = event.clientY - bounds.top;
            tooltip.setCssStyles({
                left: `${left}px`,
                top: `${Math.max(6, top - 16)}px`
            });
        };
        const handleLeave = () => {
            tooltip.classList.remove("is-visible");
        };
        dots.forEach((dot) => {
            dot.addEventListener("mouseenter", handleEnter as any);
            dot.addEventListener("mousemove", handleEnter as any);
            dot.addEventListener("mouseleave", handleLeave);
        });
    }

    getPomodoroSoundOptions() {
        return [
            {
                value: "none",
                label: "无音乐",
                icon: "music"
            },
            {
                value: "rain",
                label: "雨声",
                icon: "cloud-hail"
            },
            {
                value: "stream",
                label: "溪流",
                icon: "waves"
            },
            {
                value: "forest",
                label: "森林",
                icon: "trees"
            },
            {
                value: "white",
                label: "白噪音",
                icon: "audio-lines"
            }
        ];
    }

    getPomodoroPhaseLabel(phase: "focus" | "shortBreak" | "longBreak" = this.pomodoroState.phase) {
        return phase === "shortBreak" ? "短休息" : phase === "longBreak" ? "长休息" : "专注中";
    }

    getPomodoroPhaseDurationSeconds(phase: "focus" | "shortBreak" | "longBreak" = this.pomodoroState.phase) {
        const settings = this.getPomodoroSettings();
        if (phase === "shortBreak") return 60 * Math.max(1, settings.shortBreakMinutes || 5);
        if (phase === "longBreak") return 60 * Math.max(15, Math.min(30, settings.longBreakMinutes || 15));
        return 60 * Math.max(1, Math.min(90, settings.focusMinutes || 25));
    }

    getPomodoroHintText(phase: "focus" | "shortBreak" | "longBreak" = this.pomodoroState.phase) {
        const settings = this.getPomodoroSettings();
        return phase === "focus" || phase === "longBreak"
            ? "点击数字调整时长"
            : `鐭紤鎭?${Math.max(1, Math.min(15, settings.shortBreakMinutes || 5))} 分钟`;
    }

    resetPomodoroPhase(phase: "focus" | "shortBreak" | "longBreak" = this.pomodoroState.phase) {
        const durationSeconds = this.getPomodoroPhaseDurationSeconds(phase);
        this.pomodoroState.phase = phase;
        this.pomodoroState.durationSeconds = durationSeconds;
        this.pomodoroState.remainingSeconds = durationSeconds;
        this.pomodoroState.isRunning = false;
        this.pomodoroTargetEndAt = null;
        this.isPomodoroDurationPickerVisible = false;
        this.isPomodoroCustomInputVisible = false;
        this.pomodoroCustomMinutes = "";
    }

    formatPomodoroTime(seconds: number) {
        const safeSeconds = Math.max(0, seconds);
        const minutes = Math.floor(safeSeconds / 60);
        const rest = safeSeconds % 60;
        return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
    }

    isPomodoroReadyToStart() {
        return !this.pomodoroState.isRunning && this.pomodoroState.remainingSeconds === this.pomodoroState.durationSeconds;
    }

    async togglePomodoroPanel() {
        if (!this.isPomodoroVisible) {
            this.isPomodoroVisible = true;
            if (this.pomodoroToggleBtn) this.pomodoroToggleBtn.classList.toggle("is-active", this.isPomodoroVisible);
            await this.renderTaskList();
        }
    }

    async exitPomodoroPanel() {
        this.isPomodoroVisible = false;
        if (this.pomodoroToggleBtn) this.pomodoroToggleBtn.classList.remove("is-active");
        await this.renderTaskList();
    }

    async openPomodoroPanelAndRevealLeaf() {
        this.isPomodoroVisible = true;
        await this.renderTaskList();
        try {
            if (this.app?.workspace && this.leaf) this.app.workspace.revealLeaf(this.leaf);
        } catch (e) { }
    }

    async startPomodoro() {
        if (this.pomodoroState.isRunning) return;
        if (this.pomodoroState.remainingSeconds <= 0) this.resetPomodoroPhase(this.pomodoroState.phase);
        this.pomodoroState.isRunning = true;
        this.isPomodoroDurationPickerVisible = false;
        this.isPomodoroCustomInputVisible = false;
        this.pomodoroTargetEndAt = Date.now() + this.pomodoroState.remainingSeconds * 1000;
        this.clearPomodoroInterval();
        this.pomodoroInterval = window.setInterval(() => this.handlePomodoroTick(), 250);
        await this.startPomodoroBackgroundSound().catch(() => { });
        this.renderPomodoroPanel();
        this.updatePomodoroUI();
    }

    pausePomodoro() {
        if (!this.pomodoroState.isRunning) return;
        const remaining = getTimerRemainingSeconds(this.pomodoroTargetEndAt);
        this.pomodoroState.remainingSeconds = remaining;
        this.pomodoroState.isRunning = false;
        this.pomodoroTargetEndAt = null;
        this.clearPomodoroInterval();
        this.stopPomodoroBackgroundSound();
        this.updatePomodoroUI();
    }

    stopPomodoro() {
        this.pausePomodoro();
        this.resetPomodoroPhase("focus");
        this.renderPomodoroPanel();
        this.updatePomodoroUI();
    }

    clearPomodoroInterval() {
        if (this.pomodoroInterval) {
            window.clearInterval(this.pomodoroInterval);
            this.pomodoroInterval = null;
        }
    }

    handlePomodoroTick() {
        if (!this.pomodoroState.isRunning || !this.pomodoroTargetEndAt) return;
        const remaining = getTimerRemainingSeconds(this.pomodoroTargetEndAt);
        if (remaining !== this.pomodoroState.remainingSeconds) {
            this.pomodoroState.remainingSeconds = remaining;
            this.updatePomodoroUI();
        }
        if (remaining <= 0) this.completePomodoroPhase();
    }

    async completePomodoroPhase() {
        const phase = this.pomodoroState.phase;
        const minutes = Math.round(this.pomodoroState.durationSeconds / 60);
        this.clearPomodoroInterval();
        this.stopPomodoroBackgroundSound();
        this.pomodoroState.isRunning = false;
        this.pomodoroTargetEndAt = null;
        this.pomodoroState.remainingSeconds = 0;
        if (phase === "focus") {
            const count = this.pomodoroState.cycleFocusCount + 1;
            const isLongBreak = count >= 4;
            this.pomodoroState.cycleFocusCount = isLongBreak ? 0 : count;
            await this.recordPomodoroCompletion(minutes);
            this.resetPomodoroPhase(isLongBreak ? "longBreak" : "shortBreak");
            new Notice(isLongBreak ? "已经完成4个番茄钟，开始长休息" : "短暂休息完成，开始长休息");
        } else {
            this.resetPomodoroPhase("focus");
            new Notice("休息结束，开始新的专注");
        }
        await this.openPomodoroPanelAndRevealLeaf();
        this.updatePomodoroUI();
    }

    async cyclePomodoroSound() {
        const options = this.getPomodoroSoundOptions();
        const settings = this.getPomodoroSettings();
        const currentIndex = options.findIndex((item) => item.value === settings.selectedSound);
        const next = options[(currentIndex + 1 + options.length) % options.length];
        await this.updatePomodoroSettings({ selectedSound: next.value });
        if (this.pomodoroState.isRunning) await this.startPomodoroBackgroundSound().catch(() => { });
        else this.stopPomodoroBackgroundSound();
        this.updatePomodoroUI();
    }

    async editPomodoroDuration() {
        const phase = this.pomodoroState.phase;
        if (phase === "focus" || phase === "longBreak") {
            this.isPomodoroDurationPickerVisible = !this.isPomodoroDurationPickerVisible;
            if (!this.isPomodoroDurationPickerVisible) {
                this.isPomodoroCustomInputVisible = false;
                this.pomodoroCustomMinutes = "";
            }
            this.renderPomodoroPanel();
        } else {
            new Notice("在插入设置中调整时长");
        }
    }

    getPomodoroDurationPickerConfig() {
        if (this.pomodoroState.phase === "longBreak") {
            const settings = this.getPomodoroSettings();
            return {
                title: "从常用长休息时间开始",
                minMinutes: 15,
                maxMinutes: 30,
                defaults: DEFAULT_SETTINGS.pomodoroSettings.longBreakPresetMinutes,
                presets: normalizePomodoroPresetMinutes(
                    settings.longBreakPresetMinutes,
                    15,
                    30,
                    DEFAULT_SETTINGS.pomodoroSettings.longBreakPresetMinutes
                )
            };
        }
        const settings = this.getPomodoroSettings();
        return {
            title: "从常用番茄时间开始",
            minMinutes: 1,
            maxMinutes: 90,
            defaults: DEFAULT_SETTINGS.pomodoroSettings.focusPresetMinutes,
            presets: normalizePomodoroPresetMinutes(
                settings.focusPresetMinutes,
                1,
                90,
                DEFAULT_SETTINGS.pomodoroSettings.focusPresetMinutes
            )
        };
    }

    async removePomodoroPresetMinutes(value: number) {
        const config = this.getPomodoroDurationPickerConfig();
        if (config.defaults.includes(value)) return;
        const settings = this.getPomodoroSettings();
        if (this.pomodoroState.phase === "longBreak") {
            const next = normalizePomodoroPresetMinutes(
                (settings.longBreakPresetMinutes || []).filter((item) => item !== value),
                config.minMinutes,
                config.maxMinutes,
                config.defaults
            );
            await this.updatePomodoroSettings({ longBreakPresetMinutes: next });
        } else {
            const next = normalizePomodoroPresetMinutes(
                (settings.focusPresetMinutes || []).filter((item) => item !== value),
                config.minMinutes,
                config.maxMinutes,
                config.defaults
            );
            await this.updatePomodoroSettings({ focusPresetMinutes: next });
        }
        this.renderPomodoroPanel();
        this.updatePomodoroUI();
    }

    async applyPomodoroDurationSelection(value: number) {
        const config = this.getPomodoroDurationPickerConfig();
        if (!Number.isFinite(value) || value < config.minMinutes || value > config.maxMinutes) {
            new Notice(`请输入 ${config.minMinutes}-${config.maxMinutes} 分钟`);
            return;
        }
        if (this.pomodoroState.phase === "longBreak") {
            const settings = this.getPomodoroSettings();
            const presets = normalizePomodoroPresetMinutes(
                [...(settings.longBreakPresetMinutes || []), value],
                config.minMinutes,
                config.maxMinutes,
                DEFAULT_SETTINGS.pomodoroSettings.longBreakPresetMinutes
            );
            await this.updatePomodoroSettings({ longBreakMinutes: value, longBreakPresetMinutes: presets });
            this.pausePomodoro();
            this.resetPomodoroPhase("longBreak");
        } else {
            const settings = this.getPomodoroSettings();
            const presets = normalizePomodoroPresetMinutes(
                [...(settings.focusPresetMinutes || []), value],
                config.minMinutes,
                config.maxMinutes,
                DEFAULT_SETTINGS.pomodoroSettings.focusPresetMinutes
            );
            await this.updatePomodoroSettings({ focusMinutes: value, focusPresetMinutes: presets });
            this.pausePomodoro();
            this.resetPomodoroPhase("focus");
        }
        this.isPomodoroDurationPickerVisible = false;
        this.isPomodoroCustomInputVisible = false;
        this.pomodoroCustomMinutes = "";
        this.renderPomodoroPanel();
        this.updatePomodoroUI();
    }

    async submitPomodoroCustomDuration() {
        const value = parseInt(this.pomodoroCustomMinutes, 10);
        await this.applyPomodoroDurationSelection(value);
    }

    closePomodoroDurationPicker() {
        this.isPomodoroDurationPickerVisible = false;
        this.isPomodoroCustomInputVisible = false;
        this.pomodoroCustomMinutes = "";
        this.renderPomodoroPanel();
    }

    async startPomodoroBackgroundSound() {
        this.stopPomodoroBackgroundSound();
        const settings = this.getPomodoroSettings();
        if (!this.pomodoroState.isRunning || settings.selectedSound === "none") return;
        const AudioContextCtor: typeof AudioContext | undefined = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextCtor) return;
        if (!this.pomodoroAudioContext) this.pomodoroAudioContext = new AudioContextCtor();
        if (this.pomodoroAudioContext.state === "suspended") {
            try {
                await this.pomodoroAudioContext.resume();
            } catch (e) {
                return;
            }
        }
        if (settings.selectedSound === "forest") {
            this.pomodoroAudioNodes = this.createPomodoroForestNodes(this.pomodoroAudioContext);
            return;
        }
        const source = this.pomodoroAudioContext.createBufferSource();
        source.buffer = this.createPomodoroNoiseBuffer(
            this.pomodoroAudioContext,
            settings.selectedSound === "stream" ? "brown" : "white"
        );
        source.loop = true;
        const filter = this.pomodoroAudioContext.createBiquadFilter();
        const gain = this.pomodoroAudioContext.createGain();
        if (settings.selectedSound === "rain") {
            filter.type = "highpass";
            filter.frequency.value = 900;
            gain.gain.value = 0.015;
        } else if (settings.selectedSound === "stream") {
            filter.type = "lowpass";
            filter.frequency.value = 500;
            gain.gain.value = 0.03;
        } else {
            filter.type = "bandpass";
            filter.frequency.value = 1200;
            gain.gain.value = 0.018;
        }
        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.pomodoroAudioContext.destination);
        source.start();
        this.pomodoroAudioNodes = [source, filter, gain];
    }

    stopPomodoroBackgroundSound() {
        if (!this.pomodoroAudioNodes || this.pomodoroAudioNodes.length === 0) return;
        this.pomodoroAudioNodes.forEach((node) => {
            try {
                if (typeof (node as any).stop === "function") (node as any).stop();
            } catch (e) { }
            try {
                if (typeof (node as any).disconnect === "function") (node as any).disconnect();
            } catch (e) { }
        });
        this.pomodoroAudioNodes = [];
    }

    createPomodoroNoiseBuffer(context: AudioContext, type: "white" | "brown" = "white") {
        const length = 4 * context.sampleRate;
        const buffer = context.createBuffer(1, length, context.sampleRate);
        const data = buffer.getChannelData(0);
        let last = 0;
        for (let i = 0; i < length; i++) {
            const value = 2 * Math.random() - 1;
            if (type === "brown") {
                last = (last + 0.02 * value) / 1.02;
                data[i] = 3.5 * last;
            } else {
                data[i] = value;
            }
        }
        return buffer;
    }

    createPomodoroForestNodes(context: AudioContext) {
        const nodes: AudioNode[] = [];
        const noise = context.createBufferSource();
        noise.buffer = this.createPomodoroNoiseBuffer(context, "brown");
        noise.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 900;
        filter.Q.value = 0.35;
        const gain = context.createGain();
        gain.gain.value = 0.016;
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(context.destination);
        noise.start();
        nodes.push(noise, filter, gain);

        const bird = context.createBufferSource();
        bird.buffer = this.createPomodoroBirdBuffer(context);
        bird.loop = true;
        const birdFilter = context.createBiquadFilter();
        birdFilter.type = "highpass";
        birdFilter.frequency.value = 1400;
        const birdGain = context.createGain();
        birdGain.gain.value = 0.03;
        bird.connect(birdFilter);
        birdFilter.connect(birdGain);
        birdGain.connect(context.destination);
        bird.start();
        nodes.push(bird, birdFilter, birdGain);
        return nodes;
    }

    createPomodoroBirdBuffer(context: AudioContext) {
        const length = 6 * context.sampleRate;
        const buffer = context.createBuffer(1, length, context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = 0.004 * (2 * Math.random() - 1);
        [
            { start: 0.45, duration: 0.16, from: 2400, to: 3200 },
            { start: 0.78, duration: 0.1, from: 3100, to: 2700 },
            { start: 2.1, duration: 0.18, from: 2200, to: 3600 },
            { start: 3.35, duration: 0.12, from: 2800, to: 3400 },
            { start: 4.62, duration: 0.14, from: 2500, to: 3000 }
        ].forEach((segment) => {
            const start = Math.floor(segment.start * context.sampleRate);
            const duration = Math.floor(segment.duration * context.sampleRate);
            for (let i = 0; i < duration && start + i < length; i++) {
                const progress = i / duration;
                const freq = segment.from + (segment.to - segment.from) * progress;
                const amp = Math.sin(Math.PI * progress);
                const phase = 2 * Math.PI * freq * (i / context.sampleRate);
                data[start + i] += Math.sin(phase) * amp * 0.08;
            }
        });
        return buffer;
    }

    renderPomodoroPanel() {
        if (!this.pomodoroHostEl) return;
        this.pomodoroHostEl.empty();
        this.pomodoroElements = {};
        if (!this.isPomodoroVisible) return;
        this.getPomodoroSettings();
        const stats = this.getTodayPomodoroStats();
        const panel = this.pomodoroHostEl.createDiv("dida-pomodoro-panel");
        const summary = panel.createDiv("dida-pomodoro-summary");
        summary.textContent = `今日专注，${stats.sessions || 0} 个番茄，${stats.minutes || 0} 分钟`;

        const ringCard = panel.createDiv("dida-pomodoro-ring-card");
        let progressCircle: SVGCircleElement | null = null;
        let phaseEl: HTMLElement | null = null;
        let timeEl: HTMLElement | null = null;
        let hintEl: HTMLElement | null = null;

        if (!this.isPomodoroDurationPickerVisible || (this.pomodoroState.phase !== "focus" && this.pomodoroState.phase !== "longBreak")) {
            const ringButton = ringCard.createDiv("dida-pomodoro-ring-button");
            const ringSvg = ringButton.createSvg("svg", {
                cls: "dida-pomodoro-ring",
                attr: { viewBox: "0 0 120 120", "aria-hidden": "true" }
            });
            ringSvg.createSvg("circle", {
                cls: "dida-pomodoro-ring-track",
                attr: { cx: "60", cy: "60", r: "52" }
            });
            progressCircle = ringSvg.createSvg("circle", {
                cls: "dida-pomodoro-ring-progress",
                attr: { cx: "60", cy: "60", r: "52" }
            }) as SVGCircleElement;
            const ringCenter = ringButton.createSpan({ cls: "dida-pomodoro-ring-center" });
            phaseEl = ringCenter.createSpan({ cls: "dida-pomodoro-phase" });
            timeEl = ringCenter.createSpan({ cls: "dida-pomodoro-time" });
            hintEl = ringCenter.createSpan({ cls: "dida-pomodoro-hint" });
            if (timeEl) {
                timeEl.title = this.getPomodoroHintText(this.pomodoroState.phase);
                timeEl.setAttribute("role", "button");
                timeEl.setAttribute("tabindex", "0");
                timeEl.addEventListener("click", async (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    await this.editPomodoroDuration();
                });
                timeEl.addEventListener("keydown", async (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    await this.editPomodoroDuration();
                });
            }
        } else {
            const config = this.getPomodoroDurationPickerConfig();
            const picker = ringCard.createDiv("dida-pomodoro-picker");
            const header = picker.createDiv("dida-pomodoro-picker-header");
            header.createDiv({ cls: "dida-pomodoro-picker-title", text: config.title });
            const closeBtn = header.createEl("button", { cls: "dida-pomodoro-picker-close-btn", text: "脳" });
            closeBtn.type = "button";
            closeBtn.title = "关闭";
            closeBtn.addEventListener("click", () => this.closePomodoroDurationPicker());

            const grid = picker.createDiv("dida-pomodoro-picker-grid");
            config.presets.forEach((value) => {
                const option = grid.createEl("button", { cls: "dida-pomodoro-picker-option", text: `${value}:00` });
                option.type = "button";
                option.addEventListener("click", async () => this.applyPomodoroDurationSelection(value));
                if (!config.defaults.includes(value)) {
                    option.classList.add("is-removable");
                    const removeBtn = option.createEl("button", { cls: "dida-pomodoro-picker-remove-btn", text: "−" });
                    removeBtn.type = "button";
                    removeBtn.title = "删除选项";
                    removeBtn.setAttribute("aria-label", `移除 ${value} 分钟选项`);
                    removeBtn.addEventListener("click", async (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        await this.removePomodoroPresetMinutes(value);
                    });
                }
            });
            const customToggle = grid.createEl("button", {
                cls: "dida-pomodoro-picker-option dida-pomodoro-picker-custom-toggle",
                text: "+"
            });
            customToggle.type = "button";
            customToggle.title = "自定义时长";
            customToggle.addEventListener("click", () => {
                this.isPomodoroCustomInputVisible = !this.isPomodoroCustomInputVisible;
                if (!this.isPomodoroCustomInputVisible) this.pomodoroCustomMinutes = "";
                this.renderPomodoroPanel();
            });
            if (this.isPomodoroCustomInputVisible) {
                const row = picker.createDiv("dida-pomodoro-picker-custom-row");
                const input = row.createEl("input", {
                    type: "number",
                    cls: "dida-pomodoro-picker-custom-input",
                    placeholder: `${config.minMinutes}-${config.maxMinutes} 分钟`
                });
                input.min = String(config.minMinutes);
                input.max = String(config.maxMinutes);
                input.step = "1";
                input.value = this.pomodoroCustomMinutes;
                input.addEventListener("input", (event: any) => {
                    this.pomodoroCustomMinutes = event.target.value;
                });
                input.addEventListener("keydown", async (event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        await this.submitPomodoroCustomDuration();
                    }
                });
                const applyBtn = row.createEl("button", { cls: "dida-pomodoro-picker-apply-btn", text: "确认" });
                applyBtn.type = "button";
                applyBtn.addEventListener("click", async () => this.submitPomodoroCustomDuration());
            }
        }

        const controls = panel.createDiv("dida-pomodoro-controls");
        const readyToStart = this.isPomodoroReadyToStart();
        const isBreakPhase = this.pomodoroState.phase === "shortBreak" || this.pomodoroState.phase === "longBreak";
        if (readyToStart && isBreakPhase) controls.classList.add("is-break-ready");

        if (readyToStart) {
            const startBtn = controls.createEl("button", {
                cls: "dida-pomodoro-control-btn dida-pomodoro-primary-btn dida-pomodoro-single-start-btn"
            });
            startBtn.type = "button";
            startBtn.title = "开始";
            startBtn.textContent = "开始";
            startBtn.addEventListener("click", async () => this.startPomodoro());
            if (isBreakPhase) {
                const stopBreak = controls.createEl("button", { cls: "dida-pomodoro-control-btn" });
                stopBreak.type = "button";
                stopBreak.title = "停止休息并进入下一个专注";
                setIconElement(stopBreak, "square");
                stopBreak.addEventListener("click", () => this.stopPomodoro());
            }
        } else {
            const toggleBtn = controls.createEl("button", {
                cls: "dida-pomodoro-control-btn dida-pomodoro-primary-btn"
            });
            toggleBtn.type = "button";
            toggleBtn.addEventListener("click", async () => {
                if (this.pomodoroState.isRunning) this.pausePomodoro();
                else await this.startPomodoro();
            });
            const stopBtn = controls.createEl("button", { cls: "dida-pomodoro-control-btn" });
            stopBtn.type = "button";
            stopBtn.title = "停止";
            setIconElement(stopBtn, "square");
            stopBtn.addEventListener("click", () => this.stopPomodoro());
            const soundBtn = controls.createEl("button", { cls: "dida-pomodoro-control-btn" });
            soundBtn.type = "button";
            soundBtn.title = "切换背景音";
            soundBtn.addEventListener("click", async () => this.cyclePomodoroSound());
            this.pomodoroElements = {
                wrapper: panel,
                toggleBtn,
                soundBtn,
                progressCircle,
                phaseEl,
                timeEl,
                hintEl,
                summaryEl: summary
            };
        }

        if (readyToStart) {
            this.pomodoroElements = {
                wrapper: panel,
                toggleBtn: null,
                soundBtn: null,
                progressCircle,
                phaseEl,
                timeEl,
                hintEl,
                summaryEl: summary
            };
        }

        const trendSection = panel.createDiv("dida-pomodoro-trend-section");
        const trendHeader = trendSection.createDiv("dida-pomodoro-trend-header");
        trendHeader.createDiv({ cls: "dida-pomodoro-trend-title", text: this.getPomodoroTrendSectionTitle() });
        const tabs = trendHeader.createDiv("dida-pomodoro-trend-tabs");
        [
            { key: "week", label: "周" },
            { key: "month", label: "月" },
            { key: "year", label: "年" }
        ].forEach((item) => {
            const tab = tabs.createEl("button", {
                cls: `dida-pomodoro-trend-tab${this.pomodoroTrendPeriod === item.key ? " is-active" : ""}`,
                text: item.label
            });
            tab.type = "button";
            tab.addEventListener("click", () => {
                this.pomodoroTrendPeriod = item.key as "week" | "month" | "year";
                this.renderPomodoroPanel();
            });
        });
        const trendData = this.getPomodoroTrendData();
        const chart = trendSection.createDiv("dida-pomodoro-trend-chart");
        const plot = chart.createDiv("dida-pomodoro-trend-plot");
        const svgData = this.buildPomodoroTrendSvg(trendData, this.pomodoroTrendPeriod);
        plot.setCssStyles({
            width: `${svgData.chartWidth}px`,
            minWidth: `${svgData.chartWidth}px`
        });
        appendValidatedSvg(plot, svgData.svg);
        trendSection.createDiv("dida-pomodoro-trend-tooltip");
        const axis = chart.createDiv("dida-pomodoro-trend-axis");
        axis.setCssStyles({
            width: `${svgData.chartWidth}px`,
            minWidth: `${svgData.chartWidth}px`
        });
        svgData.points.forEach((point, index) => {
            const item = trendData[index];
            const label = axis.createDiv("dida-pomodoro-trend-axis-item");
            label.setCssStyles({ left: `${point.x}px` });
            label.createDiv("dida-pomodoro-trend-label").textContent = this.getPomodoroTrendAxisLabel(item, index, trendData.length);
        });
        this.bindPomodoroTrendTooltip(trendSection);
        this.updatePomodoroUI();
    }

    updatePomodoroUI() {
        if (!this.pomodoroElements || !this.pomodoroElements.wrapper) return;
        const settings = this.getPomodoroSettings();
        const stats = this.getTodayPomodoroStats();
        const duration = Math.max(1, this.pomodoroState.durationSeconds);
        const remaining = Math.max(0, this.pomodoroState.remainingSeconds);
        const progress = Math.min(1, Math.max(0, (duration - remaining) / duration));
        const circumference = 2 * Math.PI * 52;
        if (this.pomodoroElements.progressCircle) {
            this.pomodoroElements.progressCircle.setAttribute("stroke-dasharray", `${circumference}`);
            this.pomodoroElements.progressCircle.setAttribute("stroke-dashoffset", `${circumference * (1 - progress)}`);
        }
        this.pomodoroElements.wrapper?.setAttribute("data-phase", this.pomodoroState.phase);
        if (this.pomodoroElements.phaseEl) this.pomodoroElements.phaseEl.textContent = this.getPomodoroPhaseLabel();
        if (this.pomodoroElements.timeEl) this.pomodoroElements.timeEl.textContent = this.formatPomodoroTime(remaining);
        if (this.pomodoroElements.hintEl) this.pomodoroElements.hintEl.textContent = this.getPomodoroHintText(this.pomodoroState.phase);
        if (this.pomodoroElements.timeEl) this.pomodoroElements.timeEl.title = this.getPomodoroHintText(this.pomodoroState.phase);
        const sound = this.getPomodoroSoundOptions().find((item) => item.value === settings.selectedSound);
        if (this.pomodoroElements.summaryEl) {
            this.pomodoroElements.summaryEl.textContent = `今日专注，${stats.sessions || 0} 个番茄，${stats.minutes || 0} 分钟`;
        }
        if (this.pomodoroElements.toggleBtn) {
            this.pomodoroElements.toggleBtn.title = this.pomodoroState.isRunning ? "暂停" : "继续";
            setIconElement(this.pomodoroElements.toggleBtn, this.pomodoroState.isRunning ? "pause" : "play");
        }
        if (this.pomodoroElements.soundBtn) {
            this.pomodoroElements.soundBtn.title = sound ? sound.label : "无音乐";
            setIconElement(this.pomodoroElements.soundBtn, sound ? sound.icon : "music");
        }
    }

    async checkPluginStatusAndNotify() {
        return this.plugin.checkPluginStatusAndNotify();
    }

    getViewType() {
        return TASK_VIEW_TYPE;
    }

    getDisplayText() {
        return "滴答清单";
    }

    getIcon() {
        return "check-square";
    }

    renderTaskTitleContent(container: HTMLElement, content: string) {
        while (container.firstChild) container.removeChild(container.firstChild);

        const footnoteRegex = /\[\^([^\]]+)\]/g;
        let lastIndex = 0;
        let match;

        const processText = (parent: HTMLElement, text: string) => {
            if (text) {
                const tagRegex = /#[^\s#]+/g;
                let tagLastIndex = 0;
                let tagMatch;

                while ((tagMatch = tagRegex.exec(text)) !== null) {
                    if (tagMatch.index > tagLastIndex) {
                        parent.appendChild(document.createTextNode(text.slice(tagLastIndex, tagMatch.index)));
                    }
                    parent.createSpan({
                        cls: "dida-task-tag",
                        text: tagMatch[0]
                    });
                    tagLastIndex = tagMatch.index + tagMatch[0].length;
                }

                if (tagLastIndex < text.length) {
                    parent.appendChild(document.createTextNode(text.slice(tagLastIndex)));
                }
            }
        };

        while ((match = footnoteRegex.exec(content)) !== null) {
            if (match.index > lastIndex) {
                processText(container, content.slice(lastIndex, match.index));
            }
            container.createEl("sup", {
                cls: "dida-task-footnote"
            }).textContent = `[${match[1]}]`;
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < content.length) {
            processText(container, content.slice(lastIndex));
        }
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass("dida-task-view");
        this.viewMode = this.plugin.settings.defaultViewMode || "task";
        const handleVisibilityChange = () => {
            if (!this.pomodoroState.isRunning || !this.pomodoroTargetEndAt) return;
            if (document.visibilityState === "hidden") {
                this.clearPomodoroInterval();
                this.stopPomodoroBackgroundSound();
                return;
            }
            this.handlePomodoroTick();
            if (this.pomodoroState.isRunning && !this.pomodoroInterval) {
                this.pomodoroInterval = window.setInterval(() => this.handlePomodoroTick(), 250);
                void this.startPomodoroBackgroundSound().catch(() => { });
            }
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);
        this.eventCleanupHandlers.push(() => document.removeEventListener("visibilitychange", handleVisibilityChange));
        this.renderTaskList();
    }

    async onClose() {
        this.clearPomodoroInterval();
        this.stopPomodoroBackgroundSound();
        this.pomodoroState.isRunning = false;
        this.pomodoroTargetEndAt = null;
        if (this.eventCleanupHandlers) {
            this.eventCleanupHandlers.forEach((cleanup) => cleanup());
            this.eventCleanupHandlers = [];
        }
    }

    taskMatchesCurrentFilters(task: DidaTask, projectName: string) {
        if (this.dateFilter) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const taskDate = task.startDate ? new Date(task.startDate) : null;
            if (taskDate) taskDate.setHours(0, 0, 0, 0);

            let show = false;
            if (this.dateFilter === "overdue") {
                show = !!(taskDate && taskDate < today);
            } else if (this.dateFilter === "today") {
                show = !!(taskDate && taskDate.getTime() === today.getTime());
            } else if (this.dateFilter === "next3days") {
                const next3 = new Date(today);
                next3.setDate(next3.getDate() + 2);
                show = !!(taskDate && taskDate >= today && taskDate <= next3);
            } else if (this.dateFilter === "next7days") {
                const next7 = new Date(today);
                next7.setDate(next7.getDate() + 6);
                show = !!(taskDate && taskDate >= today && taskDate <= next7);
            }
            if (!show) return false;
        }

        if (this.searchQuery && this.searchQuery.trim()) {
            const query = this.searchQuery.toLowerCase().trim();
            const title = (task.title || "").toLowerCase();
            const content = (task.content || task.desc || "").toLowerCase();
            const pName = projectName.toLowerCase();
            if (!title.includes(query) && !content.includes(query) && !pName.includes(query)) return false;
        }

        return true;
    }

    hasActiveTaskFilter() {
        return !!((this.searchQuery && this.searchQuery.trim()) || this.dateFilter);
    }

    formatDateOnly(date: Date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }

    extractDateValue(value?: string) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        return this.formatDateOnly(date);
    }

    openCompletedDatePicker(kind: "start" | "end", trigger: HTMLElement) {
        const currentValue = kind === "start" ? this.completedTasksQuery.startDate : this.completedTasksQuery.endDate;
        new DatePickerModal(
            this.app,
            currentValue || null,
            (date) => {
                if (!date) return;
                const dateOnly = this.formatDateOnly(date);
                this.completedTasksQuery = {
                    ...this.completedTasksQuery,
                    [kind === "start" ? "startDate" : "endDate"]: this.plugin.formatDidaDateTime(
                        new Date(`${dateOnly}T${kind === "start" ? "00:00:00" : "23:59:59.999"}`)
                    )
                };
                this.renderTaskList({ preserveSearch: true });
            },
            trigger,
            undefined,
            undefined,
            { dateOnly: true }
        ).open();
    }

    async refreshCompletedTasksInline() {
        this.completedTasksLoading = true;
        this.completedTasksError = "";
        this.renderTaskList({ preserveSearch: true });
        try {
            await this.plugin.fetchCompletedTasks(this.completedTasksQuery);
        } catch (error: any) {
            this.completedTasksError = error?.message || "获取已完成任务失败";
        } finally {
            this.completedTasksLoading = false;
            this.renderTaskList({ preserveSearch: true });
        }
    }

    buildCompletedTaskQueryFromDateFilter(filter: "last7" | "last30" | "last90" = this.completedDateFilter) {
        const end = new Date();
        const start = new Date(end);
        const days = filter === "last90" ? 89 : filter === "last30" ? 29 : 6;
        start.setDate(end.getDate() - days);
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        return {
            startDate: this.plugin.formatDidaDateTime(start),
            endDate: this.plugin.formatDidaDateTime(end)
        };
    }

    hasCompletedTasksCache(query: CompletedTasksQuery = this.completedTasksQuery) {
        return this.plugin.hasCompletedTasksCache(query);
    }

    toggleCompletedTaskDetails(taskItem: HTMLElement, task: DidaTask) {
        document.querySelectorAll(".dida-task-details").forEach((el) => {
            if (!taskItem.contains(el)) el.remove();
        });

        const existing = taskItem.querySelector(".dida-task-details");
        if (existing) {
            existing.remove();
            if (this.lastOpenTaskItem === taskItem) this.lastOpenTaskItem = null;
            return;
        }

        if (this.lastOpenTaskItem && this.lastOpenTaskItem !== taskItem && this.lastOpenTaskItem.hasAttribute("draggable")) {
            this.lastOpenTaskItem.setAttribute("draggable", "true");
        }
        this.lastOpenTaskItem = taskItem;

        const details = taskItem.createDiv("dida-task-details dida-completed-task-details");
        const fields = [
            {
                label: "完成时间",
                value: task.completedTime ? this.extractDateValue(String(task.completedTime)) : "未记录"
            },
            {
                label: "原计划时间",
                value: task.dueDate ? this.extractDateValue(String(task.dueDate)) : "未设置"
            },
            {
                label: "所属项目",
                value: task.projectName || (task.projectId ? String(task.projectId) : "未记录")
            }
        ];

        fields.forEach((field) => {
            const row = details.createDiv("dida-completed-task-detail-row");
            row.createEl("span", {
                cls: "dida-completed-task-detail-label",
                text: field.label
            });
            row.createEl("span", {
                cls: "dida-completed-task-detail-value",
                text: field.value
            });
        });
    }

    renderTaskFilterBar(container: HTMLElement) {
        const filterBar = container.createDiv("dida-task-filter-bar");
        const searchContainer = filterBar.createDiv("dida-task-list-search");
        const searchInputWrap = searchContainer.createDiv("dida-search-input-wrap");
        const searchInput = searchInputWrap.createEl("input", {
            type: "text",
            cls: "dida-search-input",
            placeholder: this.taskStatusFilter === "completed" ? "搜索已完成..." : "搜索任务..."
        });
        searchInput.value = this.searchQuery;

        const clearBtn = searchInputWrap.createEl("button", {
            cls: "dida-search-clear-btn"
        });
        setIconElement(clearBtn, "x");
        clearBtn.setCssStyles({ display: this.searchQuery ? "flex" : "none" });

        searchInput.addEventListener("compositionstart", () => {
            this.isComposing = true;
        });
        searchInput.addEventListener("compositionend", (e: any) => {
            this.isComposing = false;
            const val = e.target.value;
            clearBtn.setCssStyles({ display: val ? "flex" : "none" });
            this.debouncedSearch(val);
        });
        searchInput.addEventListener("input", (e: any) => {
            const val = e.target.value;
            clearBtn.setCssStyles({ display: val ? "flex" : "none" });
            if (!this.isComposing) this.debouncedSearch(val);
        });
        clearBtn.addEventListener("click", () => {
            this.searchQuery = "";
            searchInput.value = "";
            clearBtn.setCssStyles({ display: "none" });
            this.renderTaskList({ preserveSearch: true });
        });

        const dateSelect = filterBar.createEl("select", { cls: "dida-task-date-filter-select" });
        const dateOptions = this.taskStatusFilter === "completed"
            ? [
                { label: "近 7 天", value: "last7" },
                { label: "近 30 天", value: "last30" },
                { label: "近 90 天", value: "last90" }
            ]
            : [
                { label: "全部", value: "" },
                { label: "已逾期", value: "overdue" },
                { label: "今天", value: "today" },
                { label: "近 3 天", value: "next3days" },
                { label: "近 7 天", value: "next7days" }
            ];
        dateOptions.forEach((option) => {
            const optionEl = dateSelect.createEl("option", { text: option.label });
            optionEl.value = option.value;
        });
        dateSelect.value = this.taskStatusFilter === "completed" ? this.completedDateFilter : (this.dateFilter || "");
        dateSelect.onchange = () => {
            if (this.taskStatusFilter === "completed") {
                this.completedDateFilter = dateSelect.value === "last90" || dateSelect.value === "last30" ? dateSelect.value : "last7";
                this.completedTasksQuery = this.buildCompletedTaskQueryFromDateFilter();
                this.renderTaskList({ preserveSearch: true });
                void this.refreshCompletedTasksInline();
                return;
            }
            this.dateFilter = dateSelect.value || null;
            this.renderTaskList({ preserveSearch: true });
        };

        const statusBtn = filterBar.createEl("button", {
            cls: this.taskStatusFilter === "completed" ? "dida-task-status-toggle is-completed" : "dida-task-status-toggle"
        });
        statusBtn.type = "button";
        statusBtn.title = this.taskStatusFilter === "completed" ? "点击查看未完成任务" : "点击查看已完成任务";
        setIconElement(statusBtn, this.taskStatusFilter === "completed" ? "check-check" : "circle");
        statusBtn.onclick = () => {
            const nextStatus = this.taskStatusFilter === "completed" ? "active" : "completed";
            this.taskStatusFilter = nextStatus;
            if (nextStatus === "completed") {
                if (!this.completedTasksQuery.startDate || !this.completedTasksQuery.endDate) {
                    this.completedTasksQuery = this.buildCompletedTaskQueryFromDateFilter();
                }
                this.renderTaskList({ preserveSearch: true });
                if (!this.hasCompletedTasksCache(this.completedTasksQuery)) {
                    void this.refreshCompletedTasksInline();
                }
                return;
            }
            this.renderTaskList({ preserveSearch: true });
        };
    }

    renderCompletedTasksInline(container: HTMLElement) {
        if (this.completedTasksError) {
            container.createEl("p", { text: `已完成任务刷新失败：${this.completedTasksError}`, cls: "dida-empty-state" });
        }
        if (this.completedTasksLoading) {
            container.createEl("p", { text: "正在刷新已完成任务...", cls: "dida-empty-state" });
            return;
        }

        let tasks = this.plugin.getCompletedTasksFromCache(this.completedTasksQuery) as DidaTask[];
        tasks = tasks
            .slice()
            .sort((a, b) => {
                const left = new Date(a.completedTime || a.updatedAt || a.createdAt || 0 as any).getTime();
                const right = new Date(b.completedTime || b.updatedAt || b.createdAt || 0 as any).getTime();
                return right - left;
            });
        if (this.searchQuery && this.searchQuery.trim()) {
            const query = this.searchQuery.toLowerCase().trim();
            tasks = tasks.filter((task) => {
                const title = (task.title || "").toLowerCase();
                const content = (task.content || task.desc || "").toLowerCase();
                const projectName = (task.projectName || "").toLowerCase();
                return title.includes(query) || content.includes(query) || projectName.includes(query);
            });
        }

        if (tasks.length === 0) {
            container.createEl("p", { text: "当前范围内没有已完成任务", cls: "dida-empty-state" });
            return;
        }

        const list = container.createDiv("dida-completed-inline-list");
        tasks.forEach((task) => {
            const item = list.createDiv("dida-task-item dida-completed-task-item");
            const mainRow = item.createDiv("dida-task-main-row");
            const leftContent = mainRow.createDiv("dida-task-left-content");
            const checkbox = leftContent.createEl("input", { type: "checkbox" });
            checkbox.checked = true;
            checkbox.title = "恢复为未完成";
            checkbox.onchange = async () => {
                checkbox.disabled = true;
                try {
                    await this.plugin.restoreCompletedTask(task);
                    this.renderTaskList({ preserveSearch: true });
                } catch (error: any) {
                    checkbox.checked = true;
                    checkbox.disabled = false;
                    new Notice(error?.message || "恢复任务失败");
                }
            };

            const titleEl = leftContent.createEl("span", {
                cls: "dida-task-completed dida-task-title-clickable"
            });
            this.renderTaskTitleContent(titleEl, task.title || "无标题任务");
            titleEl.onclick = () => this.toggleCompletedTaskDetails(item, task);
        });
    }

    resolveVisibleRootTask(task: DidaTask, taskByKey: Map<string, DidaTask>) {
        let current = task;
        const seen = new Set<string>();
        while (current.parentId) {
            const key = getDidaTaskTreeKey(current);
            if (key) {
                if (seen.has(key)) break;
                seen.add(key);
            }
            const parent = taskByKey.get(current.parentId);
            if (!parent || parent.status === 2) break;
            current = parent;
        }
        return current;
    }

    renderTaskTreeItem(
        container: HTMLElement,
        task: DidaTask,
        childrenByParentId: Map<string, DidaTask[]>,
        renderableTaskKeys: Set<string> | null = null,
        matchedTaskKeys: Set<string> | null = null,
        forceExpandedTaskKeys: Set<string> | null = null,
        depth: number = 0,
        ancestors: Set<string> = new Set()
    ) {
        const taskKey = getDidaTaskTreeKey(task);
        if (taskKey && renderableTaskKeys && !renderableTaskKeys.has(taskKey)) return;
        if (taskKey && ancestors.has(taskKey)) return;
        const nextAncestors = new Set(ancestors);
        if (taskKey) nextAncestors.add(taskKey);
        const children = (taskKey ? (childrenByParentId.get(taskKey) || []) : []).filter((child) => {
            const childKey = getDidaTaskTreeKey(child);
            return !renderableTaskKeys || (!!childKey && renderableTaskKeys.has(childKey));
        });

        const taskItem = container.createDiv("dida-task-item");
        taskItem.addClass("dida-task-tree-item");
        if (depth > 0) taskItem.addClass("dida-task-tree-child");
        taskItem.setAttribute("data-task-id", task.id);
        taskItem.setAttribute("data-task-depth", String(depth));
        const visualDepth = Math.min(depth, 8);
        taskItem.style.setProperty("--dida-task-depth", String(visualDepth));
        taskItem.style.paddingLeft = `${visualDepth * 18}px`;
        taskItem.setAttribute("draggable", "true");
        taskItem.addEventListener("dragstart", (e) => {
            e.stopPropagation();
            taskItem.classList.add("dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "copyMove";
                e.dataTransfer.setData("application/x-dida-task", task.id);
            }
        });
        taskItem.addEventListener("dragend", (e) => {
            e.stopPropagation();
            taskItem.classList.remove("dragging");
            taskItem.classList.remove("dida-task-drop-parent-target");
            document.querySelectorAll(".dida-project-header").forEach((h) => h.classList.remove("drag-over"));
            document.querySelectorAll(".dida-task-drop-parent-target").forEach((h) => h.classList.remove("dida-task-drop-parent-target"));
        });
        taskItem.addEventListener("dragover", (e) => {
            if (!e.dataTransfer?.types.includes("application/x-dida-task")) return;
            const draggedTaskId = e.dataTransfer.getData("application/x-dida-task");
            if (!draggedTaskId || draggedTaskId === task.id || draggedTaskId === task.didaId) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            taskItem.classList.add("dida-task-drop-parent-target");
        });
        taskItem.addEventListener("dragleave", (e) => {
            e.stopPropagation();
            if (e.target === taskItem || !taskItem.contains(e.relatedTarget as Node | null)) {
                taskItem.classList.remove("dida-task-drop-parent-target");
            }
        });
        taskItem.addEventListener("drop", async (e) => {
            const draggedTaskId = e.dataTransfer?.getData("application/x-dida-task");
            if (!draggedTaskId) return;
            e.preventDefault();
            e.stopPropagation();
            taskItem.classList.remove("dida-task-drop-parent-target");
            const draggedTask = (this.plugin.settings.tasks || []).find((item) => item.id === draggedTaskId || item.didaId === draggedTaskId);
            if (!draggedTask) return;
            try {
                await this.plugin.reparentTask(draggedTask, task);
                new Notice(`已设为 ${task.title || "目标任务"} 的子任务`);
            } catch (error: any) {
                new Notice(error?.message || "设置子任务失败");
            }
        });

        const mainRow = taskItem.createDiv("dida-task-main-row");
        const leftContent = mainRow.createDiv("dida-task-left-content");
        const rightButtons = mainRow.createDiv("dida-task-right-buttons");

        const checkbox = leftContent.createEl("input", { type: "checkbox" });
        checkbox.checked = task.status === 2;
        checkbox.onchange = debounce(() => {
            const idx = this.resolveTaskOriginalIndex(task);
            if (idx === -1) {
                new Notice("未找到对应任务，无法切换完成状态");
                return;
            }
            this.toggleTask(idx);
        }, 200);

        const titleSpan = leftContent.createEl("span", {
            cls: task.status === 2 ? "dida-task-completed dida-task-title-clickable" : "dida-task-title dida-task-title-clickable"
        });
        this.renderTaskTitleContent(titleSpan, task.title || "");
        titleSpan.onclick = () => this.toggleTaskDetails(taskItem, task);

        this.updateTaskRowRepeatRule(taskItem, task);
        this._enableTaskDragToMarkdown(taskItem, task);

        let reminderInfo = "";
        try {
            if (task.isAllDay) {
                reminderInfo = "全天";
            } else {
                const hasStartDate = !!task.startDate;
                const hasDueDate = !!task.dueDate;
                if (hasStartDate || hasDueDate) {
                    let startStr = "";
                    let dueStr = "";
                    if (hasStartDate) {
                        const d = new Date(task.startDate);
                        startStr = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
                    }
                    if (hasDueDate) {
                        const d = new Date(task.dueDate);
                        dueStr = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
                    }
                    if (startStr && dueStr) reminderInfo = startStr + "～" + dueStr;
                    else if (startStr) reminderInfo = startStr;
                    else if (dueStr) reminderInfo = dueStr;
                }
            }
        } catch (e) {
            reminderInfo = "";
        }

        if (reminderInfo) {
            const reminderSpan = document.createElement("span");
            reminderSpan.className = "dida-task-reminder-inline";
            reminderSpan.addClass("dida-inline-flex-center");
            setTextWithIcon(reminderSpan, reminderInfo, "timer", { textFirst: true });
            const repeatDiv = taskItem.querySelector(".dida-task-repeat-rule");
            if (repeatDiv) {
                repeatDiv.appendChild(reminderSpan);
            } else {
                const newRepeatDiv = document.createElement("div");
                newRepeatDiv.className = "dida-task-repeat-rule";
                newRepeatDiv.appendChild(reminderSpan);
                taskItem.appendChild(newRepeatDiv);
            }
        }

        this.updateTaskRowSubtaskCount(taskItem, task);
        this.updateTaskRowChildCount(taskItem, task);

        const prioritySpan = rightButtons.createEl("span", { cls: "dida-task-priority" });
        prioritySpan.textContent = this.formatPriorityLabel(task.priority || 0);
        prioritySpan.title = "点击切换优先级";
        prioritySpan.addClass("dida-clickable-date");
        prioritySpan.onclick = async (e) => {
            e.stopPropagation();
            const idx = this.resolveTaskOriginalIndex(task);
            if (idx === -1) {
                new Notice("未找到对应任务，无法更新优先级");
                return;
            }
            await this.cycleTaskPriority(idx);
        };

        const dateSpan = rightButtons.createEl("span", { cls: "dida-task-due-date" });
        if (task.startDate) {
            try {
                const date = new Date(task.startDate);
                dateSpan.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                date.setHours(0, 0, 0, 0);
                if (date < today) dateSpan.classList.add("overdue");
                else if (date.getTime() === today.getTime()) dateSpan.classList.add("today");
            } catch (e) {
                dateSpan.textContent = "";
            }
        } else {
            setIconElement(dateSpan, "calendar-x-2");
            dateSpan.classList.add("no-date");
        }

        dateSpan.addClass("dida-clickable-date");
        dateSpan.title = "点击设置开始时间";
        dateSpan.onclick = (e) => {
            e.stopPropagation();
            const idx = this.resolveTaskOriginalIndex(task);
            if (idx === -1) {
                new Notice("未找到对应任务，无法更新时间");
                return;
            }
            new DatePickerModal(this.app, task.startDate || task.dueDate || null, async (date, isAllDay, endDate, repeatFlag) => {
                await this.updateTaskSchedule(idx, date, isAllDay, endDate, repeatFlag);
            }, e.currentTarget as HTMLElement, this.plugin, idx).open();
        };

        const deleteBtn = rightButtons.createEl("button", { cls: "dida-task-delete" });
        setIconElement(deleteBtn, "x");
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (window.confirm("确定要删除这个任务吗？")) {
                const idx = this.resolveTaskOriginalIndex(task);
                if (idx === -1) {
                    new Notice("未找到对应任务，无法删除");
                    return;
                }
                this.deleteTask(idx);
            }
        };

        const syncStatusSpan = rightButtons.createEl("span", {
            cls: task.didaId ? "dida-sync-status synced" : "dida-sync-status unsynced"
        });
        if (task.syncPlacementPending) {
            syncStatusSpan.removeClass("synced", "unsynced");
            syncStatusSpan.addClass("pending");
            syncStatusSpan.title = "任务位置同步中";
            setIconElement(syncStatusSpan, "git-branch-plus");
        } else if (task.syncPlacementError) {
            syncStatusSpan.removeClass("synced", "unsynced");
            syncStatusSpan.addClass("error");
            syncStatusSpan.title = task.syncPlacementError;
            setIconElement(syncStatusSpan, "cloud-alert");
        } else {
            setIconElement(syncStatusSpan, task.didaId ? "cloud-check" : "cloud-alert");
        }

        if (matchedTaskKeys && taskKey && !matchedTaskKeys.has(taskKey)) {
            taskItem.addClass("dida-task-filter-context");
        }

        const collapsed = resolveDidaTaskCollapsedState(task, children.length, this.plugin.settings.childTaskCollapsedStates);
        const shouldExpandChildren = !collapsed || (!!taskKey && !!forceExpandedTaskKeys?.has(taskKey));
        if (!shouldExpandChildren) return;

        for (const child of children) {
            this.renderTaskTreeItem(container, child, childrenByParentId, renderableTaskKeys, matchedTaskKeys, forceExpandedTaskKeys, depth + 1, nextAncestors);
        }
    }

    async renderTaskList(options: { preserveSearch?: boolean } = {}) {
        const container = this.containerEl.children[1];
        let taskListContainer: HTMLElement;

        if (this.viewMode === "note" && !this.plugin.settings.enableDidaNoteSync) {
            this.viewMode = "task";
        }

        if (this.isPomodoroVisible && (Platform.isMobile || this.plugin.settings.showPomodoroEntry === false)) {
            await this.exitPomodoroPanel();
        }

        if (this.isPomodoroVisible && options && options.preserveSearch) {
            options = {};
        }

        if (options && options.preserveSearch) {
            const existingList = container.querySelector(".dida-task-list") as HTMLElement;
            if (existingList && existingList.parentElement === container) {
                existingList.empty();
                taskListContainer = existingList;
            } else {
                container.empty();
                taskListContainer = container.createDiv("dida-task-list");
            }
        } else {
            container.empty();
            const header = container.createDiv("dida-task-header");
            const headerTitle = header.createEl("h3");
            setTextWithIcon(headerTitle, "滴答清单", "circle-check-big");
            const headerControls = header.createDiv("dida-task-header-controls");

            // View toggle button
            const viewToggleBtn = headerControls.createEl("button", {
                cls: "dida-timeline-btn dida-time-block-toggle-btn"
            });

            if (this.viewMode === "note") {
                setIconElement(viewToggleBtn, "list-checks");
                viewToggleBtn.title = "切换到任务列表";
            } else if (this.viewMode === "timeblock") {
                setIconElement(viewToggleBtn, "list-checks");
                viewToggleBtn.title = "切换到任务列表";
            } else {
                setIconElement(viewToggleBtn, "align-start-vertical");
                viewToggleBtn.title = "切换到时间段视图";
            }
            viewToggleBtn.onclick = async () => {
                if (this.isPomodoroVisible) {
                    await this.exitPomodoroPanel();
                } else if (this.viewMode === "note") {
                    this.viewMode = "task";
                    this.renderTaskList();
                } else {
                    this.toggleViewMode();
                }
            };

            if (this.plugin.settings.enableDidaNoteSync) {
                const noteSyncBtn = headerControls.createEl("button", {
                    cls: "dida-sync-btn dida-note-sync-btn"
                });
                setIconElement(noteSyncBtn, "notebook-tabs");
                noteSyncBtn.title = "查看滴答笔记";
                noteSyncBtn.onclick = async () => {
                    if (this.plugin.isPluginActivated) {
                        this.viewMode = "note";
                        await this.renderTaskList();
                    } else {
                        await this.checkPluginStatusAndNotify();
                    }
                };
            }

            // Sync button
            const syncBtn = headerControls.createEl("button", {
                cls: "dida-sync-btn"
            });
            setIconElement(syncBtn, "refresh-cw");
            const syncing = this.plugin.isManualSyncing || this.plugin.syncManager?.isSyncing === true;
            syncBtn.classList.toggle("is-syncing", syncing);
            syncBtn.disabled = syncing;
            syncBtn.title = syncing ? "正在同步" : "手动同步";
            syncBtn.onclick = async () => {
                if (this.plugin.isPluginActivated) {
                    await this.plugin.safeManualSync();
                } else {
                    await this.checkPluginStatusAndNotify();
                }
            };

            if (!Platform.isMobile && this.plugin.settings.showTimelineEntry !== false) {
                const timelineBtn = headerControls.createEl("button", {
                    cls: "dida-timeline-btn"
                });
                setIconElement(timelineBtn, "calendar-check");
                timelineBtn.title = "打开时间线视图";
                timelineBtn.onclick = async () => {
                    if (this.isPomodoroVisible) {
                        await this.exitPomodoroPanel();
                    } else {
                        this.plugin.showTimelineView();
                    }
                };
            }

            if (!Platform.isMobile && this.plugin.settings.showPomodoroEntry !== false) {
                const pomodoroToggleBtn = headerControls.createEl("button", {
                    cls: "dida-timeline-btn dida-pomodoro-toggle-btn"
                });
                setIconElement(pomodoroToggleBtn, "circle-star");
                pomodoroToggleBtn.title = this.isPomodoroVisible ? "番茄钟模式中，请点击视图切换按钮返回任务列表" : "显示番茄钟";
                pomodoroToggleBtn.disabled = this.isPomodoroVisible;
                if (this.isPomodoroVisible) {
                    pomodoroToggleBtn.classList.add("is-locked");
                } else {
                    pomodoroToggleBtn.addEventListener("click", async () => {
                        await this.togglePomodoroPanel();
                    });
                }
                this.pomodoroToggleBtn = pomodoroToggleBtn;
            } else {
                this.pomodoroToggleBtn = null;
            }

            this.pomodoroHostEl = container.createDiv("dida-pomodoro-host");
            this.renderPomodoroPanel();
            if (this.pomodoroToggleBtn) {
                this.pomodoroToggleBtn.classList.toggle("is-active", this.isPomodoroVisible);
            }
            if (this.isPomodoroVisible) {
                taskListContainer = container.createDiv("dida-task-list dida-pomodoro-only-view");
                return;
            }

            taskListContainer = container.createDiv("dida-task-list");
        }

        if (this.viewMode === "note") {
            this.renderDidaNoteSyncPanel(taskListContainer);
        } else if (this.viewMode === "timeblock") {
            this.renderTimeBlockView(taskListContainer);
        } else {
            this.renderTaskFilterBar(taskListContainer);
            if (this.taskStatusFilter === "completed") {
                this.renderCompletedTasksInline(taskListContainer);
                return;
            }

            // Task List View implementation
            try {
                if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) {
                    taskListContainer.empty();
                    taskListContainer.createEl("p", {
                        text: "离线中：Dida sync 不可用",
                        cls: "dida-empty-state"
                    });
                    return;
                }
            } catch (e) { }

            const tasks = (this.plugin.settings.tasks || [])
                .map((task, index) => task ? { ...task, originalIndex: index } : task)
                .filter((task) => task && this.plugin.isTaskListItem(task) && task.status !== 2);
            if (tasks.length === 0 && this.plugin.getProjectCatalog().length === 0) {
                taskListContainer.createEl("p", {
                    text: "暂无任务，请先添加一些任务",
                    cls: "dida-empty-state"
                });
            } else {
                const projectMap = new Map<string, any[]>();
                const projectInfoMap = new Map<string, any>();
                const projectOrder = this.plugin.settings.projectOrder || [];

                if (!this.dateFilter) {
                    this.plugin.getAvailableProjectConfigs().forEach((project) => {
                        if (!project || !project.name) return;
                        if (!this.plugin.settings.showArchivedProjects && project.isArchived) return;
                        if (!this.plugin.isProjectVisible(project.id, project.name)) return;
                        if (this.searchQuery && this.searchQuery.trim()) {
                            const query = this.searchQuery.toLowerCase().trim();
                            if (!project.name.toLowerCase().includes(query)) return;
                        }
                        if (!projectMap.has(project.name)) {
                            projectMap.set(project.name, []);
                            projectInfoMap.set(project.name, {
                                name: project.name,
                                id: project.id,
                                isArchived: project.isArchived === true,
                                isLocalOnly: project.isLocalOnly === true
                            });
                        }
                    });
                }

                const taskTreeIndex = buildDidaTaskTreeIndex(tasks as DidaTask[]);
                const taskByKey = new Map<string, DidaTask>();
                tasks.forEach((task) => {
                    task.content = typeof task.content === "string" ? task.content : (task.content || "");
                    for (const key of getDidaTaskTreeKeys(task as DidaTask)) taskByKey.set(key, task as DidaTask);
                });

                const matchedTasks: DidaTask[] = [];
                const canIncludeTaskInFilteredTree = (task: DidaTask) => {
                    if (!this.plugin.isTaskListItem(task)) return false;
                    const projectInfo = this.plugin.resolveTaskProjectInfo(task);
                    if (!this.plugin.settings.showArchivedProjects && projectInfo.isArchived) return false;
                    if (!this.plugin.isProjectVisible(projectInfo.id, projectInfo.name)) return false;
                    if (task.status === 2) return false;
                    return true;
                };

                const visibleRootKeys = new Set<string>();
                tasks.forEach((task) => {
                    const projectInfo = this.plugin.resolveTaskProjectInfo(task);
                    const projectName = projectInfo.name;
                    const projectId = projectInfo.id;
                    const isArchived = projectInfo.isArchived;
                    if (!this.plugin.settings.showArchivedProjects && isArchived) return;
                    if (!this.plugin.isProjectVisible(projectId, projectName)) return;
                    if (!this.taskMatchesCurrentFilters(task as DidaTask, projectName)) return;
                    matchedTasks.push(task as DidaTask);
                });

                const filterSets = buildDidaTaskFilterSets(tasks as DidaTask[], matchedTasks, canIncludeTaskInFilteredTree);
                const matchedTaskKeys = filterSets.matchedTaskKeys;
                const renderableTaskKeys = filterSets.renderableTaskKeys;
                const shouldForceExpandMatches = this.hasActiveTaskFilter();
                const forceExpandedTaskKeys = shouldForceExpandMatches ? renderableTaskKeys : null;

                matchedTasks.forEach((task) => {
                    const root = this.resolveVisibleRootTask(task as DidaTask, taskByKey);
                    const rootKey = getDidaTaskTreeKey(root);
                    if (!rootKey || visibleRootKeys.has(rootKey)) return;
                    if (!renderableTaskKeys.has(rootKey)) return;
                    visibleRootKeys.add(rootKey);

                    const rootProjectInfo = this.plugin.resolveTaskProjectInfo(root);
                    const rootProjectName = rootProjectInfo.name;
                    if (!projectMap.has(rootProjectName)) {
                        projectMap.set(rootProjectName, []);
                        projectInfoMap.set(rootProjectName, {
                            name: rootProjectName,
                            id: rootProjectInfo.id,
                            isArchived: rootProjectInfo.isArchived,
                            isLocalOnly: rootProjectInfo.isLocalOnly
                        });
                    }
                    projectMap.get(rootProjectName).push(root);
                });

                if (projectMap.size === 0) {
                    taskListContainer.createEl("p", {
                        text: "暂无任务，请先添加一些任务",
                        cls: "dida-empty-state"
                    });
                    return;
                }

                const sortedProjects = Array.from(projectMap.entries()).sort(([nameA, tasksA], [nameB, tasksB]) => {
                    return compareProjectGroups(
                        { name: nameA, taskCount: tasksA.length },
                        { name: nameB, taskCount: tasksB.length },
                        projectOrder
                    );
                });

                for (const [projectName, projectTasks] of sortedProjects) {
                    const projectInfo = projectInfoMap.get(projectName) || { name: projectName, id: "inbox" };
                    const projectHeader = taskListContainer.createDiv("dida-project-header");

                    const titleEl = projectHeader.createEl("h4", {
                        cls: projectInfo.isArchived ? "dida-project-title archived" : "dida-project-title"
                    });

                    const tasksInProject = tasks.filter(t => {
                        let pName = "本地任务";
                        if (t.projectName && t.projectId) {
                            pName = t.projectName;
                        } else if (t.projectId) {
                            pName = (t.projectId === "inbox" || t.projectId.includes("inbox")) ? "收集箱" : t.projectId;
                        } else if (t.projectName) {
                            pName = t.projectName;
                        }
                        return pName === projectName;
                    });

                    const rootTaskKeys = new Set(projectTasks.map(task => getDidaTaskTreeKey(task)).filter(Boolean) as string[]);
                    const visibleSubtaskCount = tasksInProject.filter((t) => {
                        const key = getDidaTaskTreeKey(t as DidaTask);
                        return !!key && matchedTaskKeys.has(key) && !!t.parentId && !rootTaskKeys.has(key);
                    }).length;
                    const countText = visibleSubtaskCount > 0 ? `${projectName} (${projectTasks.length}+${visibleSubtaskCount})` : `${projectName} (${projectTasks.length})`;

                    titleEl.createEl("span", { text: countText });
                    if (projectInfo.isArchived) {
                        const archived = titleEl.createSpan({ cls: "dida-project-archived-icon" });
                        setIconElement(archived, "archive");
                    }
                    titleEl.onclick = () => this.toggleProjectCollapse(projectHeader, tasksContainer, projectName);
                    titleEl.addEventListener("contextmenu", (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        this.plugin.openProjectContextMenu(projectInfo, event);
                    });
                    titleEl.setAttribute("draggable", "true");
                    titleEl.setAttribute("data-project-name", projectName);

                    // Drag and drop for projects
                    titleEl.addEventListener("dragstart", (e) => {
                        e.stopPropagation();
                        projectHeader.classList.add("dragging");
                        if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("application/x-dida-project", projectName);
                        }
                    });

                    titleEl.addEventListener("dragend", (e) => {
                        e.stopPropagation();
                        projectHeader.classList.remove("dragging");
                        document.querySelectorAll(".dida-project-header").forEach(h => {
                            h.classList.remove("drag-over");
                        });
                    });

                    projectHeader.addEventListener("dragover", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                        const dragging = document.querySelector(".dragging");
                        if (dragging && dragging !== projectHeader) {
                            projectHeader.classList.add("drag-over");
                        }
                    });

                    projectHeader.addEventListener("dragleave", (e) => {
                        e.stopPropagation();
                        if (e.target === projectHeader) {
                            projectHeader.classList.remove("drag-over");
                        }
                    });

                    projectHeader.addEventListener("drop", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        projectHeader.classList.remove("drag-over");
                        if (e.dataTransfer) {
                            const draggedTaskId = e.dataTransfer.getData("application/x-dida-task");
                            if (draggedTaskId) {
                                const draggedTask = (this.plugin.settings.tasks || []).find((item) => item.id === draggedTaskId || item.didaId === draggedTaskId);
                                if (draggedTask) {
                                    void this.plugin.moveTaskToProject(draggedTask, projectInfo.id)
                                        .then(() => new Notice(`任务已移动到 ${projectInfo.name}`))
                                        .catch((error: any) => new Notice(error?.message || "移动任务失败"));
                                }
                                return;
                            }
                            const draggedProject = e.dataTransfer.getData("application/x-dida-project") || e.dataTransfer.getData("text/plain");
                            if (draggedProject && draggedProject !== projectName) {
                                this.reorderProjects(draggedProject, projectName);
                            }
                        }
                    });

                    const addTaskBtn = projectHeader.createEl("button", {
                        cls: "dida-project-add-task-btn"
                    });
                    setIconElement(addTaskBtn, "plus");
                    addTaskBtn.onclick = (e) => this.showAddTaskModal(projectName, projectInfo.id, e.currentTarget as HTMLElement);

                    const tasksContainer = taskListContainer.createDiv("dida-project-tasks");

                    tasksContainer.addEventListener("dragover", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (e.dataTransfer?.types.includes("application/x-dida-task")) {
                            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                            projectHeader.classList.add("drag-over");
                        }
                    });

                    tasksContainer.addEventListener("dragleave", (e) => {
                        e.stopPropagation();
                        if (e.target === tasksContainer) projectHeader.classList.remove("drag-over");
                    });

                    tasksContainer.addEventListener("drop", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        projectHeader.classList.remove("drag-over");
                        const draggedTaskId = e.dataTransfer?.getData("application/x-dida-task");
                        if (!draggedTaskId) return;
                        const draggedTask = (this.plugin.settings.tasks || []).find((item) => item.id === draggedTaskId || item.didaId === draggedTaskId);
                        if (!draggedTask) return;
                        void this.plugin.moveTaskToProject(draggedTask, projectInfo.id)
                            .then(() => new Notice(`任务已移动到 ${projectInfo.name}`))
                            .catch((error: any) => new Notice(error?.message || "移动任务失败"));
                    });

                    if (!this.searchQuery && !this.dateFilter && this.plugin.settings.projectCollapsedStates[projectName]) {
                        tasksContainer.classList.add("collapsed");
                        projectHeader.classList.add("collapsed");
                    }

                    sortDidaTasksForTree(projectTasks as DidaTask[]).forEach(task => {
                        this.renderTaskTreeItem(tasksContainer, task, taskTreeIndex.childrenByParentId, renderableTaskKeys, matchedTaskKeys, forceExpandedTaskKeys);
                    });
                }
            }
        }
    }

    renderDidaNoteSyncPanel(container: Element) {
        const taskListContainer = container as HTMLElement;
        taskListContainer.empty();
        taskListContainer.addClass("dida-note-list-view");

        const records = this.plugin.settings.didaNoteSyncRecords || [];
        const recordByDidaId = new Map(records.map((record) => [record.didaId, record]));
        const cachedNoteTasks = (this.plugin.settings.tasks || []).filter((task) => this.plugin.isNoteListItem(task));
        const displayedCachedNoteIds = new Set<string>();
        const displayRecords = [
            ...cachedNoteTasks.map((task) => {
                const didaId = task.didaId || task.id || "";
                if (didaId) displayedCachedNoteIds.add(didaId);
                const record = didaId ? recordByDidaId.get(didaId) : null;
                return record || {
                    didaId,
                    title: task.title || "Untitled",
                    path: "",
                    projectId: task.projectId,
                    projectName: task.projectName,
                    etag: task.etag || null,
                    remoteModifiedTime: task.updatedAt || null,
                    lastSyncedContentHash: "",
                    lastSyncedAt: task.updatedAt || new Date().toISOString(),
                    status: "missing" as const,
                    remoteMissing: false,
                    error: "尚未同步为 Markdown"
                };
            }),
            ...records.filter((record) => {
                if (displayedCachedNoteIds.has(record.didaId)) return false;
                return true;
            })
        ];
        const lastRun = this.plugin.settings.didaNoteSyncLastRun;
        const conflicts = displayRecords.filter((record) => record.status === "conflict").length;
        const errors = displayRecords.filter((record) => record.status === "error").length;
        const missing = displayRecords.filter((record) => record.status === "missing" || record.remoteMissing).length;
        const issueCount = conflicts + errors + missing;
        const renderFooter = () => {
            const footer = taskListContainer.createDiv("dida-note-sync-footer");
            const summary = footer.createDiv("dida-note-sync-footer-summary");
            summary.createEl("span", { text: `已同步笔记 ${displayRecords.length}` });
            if (lastRun) {
                const updatedCount = this.getNoteSyncRunUpdatedCount(lastRun);
                const currentIssueCount = this.getNoteSyncRunIssueCount(lastRun);
                if (updatedCount > 0) summary.createEl("span", { text: `更新 ${updatedCount}`, cls: "is-update" });
                if (currentIssueCount > 0) summary.createEl("span", { text: `异常 ${currentIssueCount}`, cls: "is-error" });
                if (updatedCount === 0 && currentIssueCount === 0) {
                    summary.createEl("span", { text: "状态正常", cls: "is-ok" });
                }
            } else if (issueCount > 0) {
                summary.createEl("span", { text: `异常 ${issueCount}`, cls: "is-error" });
            }
        };

        if (!this.plugin.settings.enableDidaNoteSync) {
            taskListContainer.createEl("p", {
                text: "滴答笔记同步未启用，请先在设置中启用。",
                cls: "dida-empty-state"
            });
            return;
        }

        if ((this.plugin.settings.didaNoteSyncProjectIds || []).length === 0) {
            const emptyText = displayRecords.length === 0
                ? "尚未选择笔记同步清单，请先在设置中选择清单。"
                : "尚未选择笔记同步清单，下方仅显示已有本地同步记录。";
            taskListContainer.createEl("p", {
                text: emptyText,
                cls: "dida-empty-state"
            });
            renderFooter();
            if (displayRecords.length === 0) return;
        }

        if (displayRecords.length === 0) {
            taskListContainer.createEl("p", {
                text: "暂无已同步笔记，点击顶部同步按钮拉取。",
                cls: "dida-empty-state"
            });
            renderFooter();
            return;
        }

        const groups = new Map<string, { projectId: string; projectName: string; records: typeof displayRecords }>();
        displayRecords
            .slice()
            .sort((a, b) => new Date(b.lastSyncedAt || 0).getTime() - new Date(a.lastSyncedAt || 0).getTime())
            .forEach((record) => {
                const display = this.plugin.getProjectDisplayInfo
                    ? this.plugin.getProjectDisplayInfo(record.projectId || "", record.projectName)
                    : { id: record.projectId || "unknown", name: record.projectName || record.projectId || "未知清单" };
                const projectId = display.id || "unknown";
                const projectName = display.name || (projectId === "unknown" ? "未知清单" : projectId);
                if (!groups.has(projectId)) groups.set(projectId, { projectId, projectName, records: [] });
                groups.get(projectId)!.records.push(record);
            });

        Array.from(groups.values()).forEach((group) => {
            const projectHeader = taskListContainer.createDiv("dida-project-header");
            const titleEl = projectHeader.createEl("h4", { cls: "dida-project-title" });
            titleEl.createEl("span", { text: `${group.projectName} (${group.records.length})` });
            const list = taskListContainer.createDiv("dida-project-tasks");
            const collapseKey = `note:${group.projectId || group.projectName}`;
            const collapsed = this.plugin.settings.projectCollapsedStates?.[collapseKey] === true;
            projectHeader.classList.toggle("collapsed", collapsed);
            list.classList.toggle("collapsed", collapsed);
            titleEl.onclick = async () => {
                const nextCollapsed = !list.classList.contains("collapsed");
                list.classList.toggle("collapsed", nextCollapsed);
                projectHeader.classList.toggle("collapsed", nextCollapsed);
                this.plugin.settings.projectCollapsedStates = {
                    ...(this.plugin.settings.projectCollapsedStates || {}),
                    [collapseKey]: nextCollapsed
                };
                await this.plugin.saveSettings();
            };

            group.records.forEach((record) => {
                const file = record.path ? this.plugin.app.vault.getAbstractFileByPath(record.path) : null;
                const fileMissing = !file;
                const status = fileMissing ? "missing" : record.status;
                const item = list.createDiv("dida-task-item dida-note-sync-record");
                item.addClass(`is-${status}`);
                const mainRow = item.createDiv("dida-task-main-row");
                const leftContent = mainRow.createDiv("dida-task-left-content");
                const rightButtons = mainRow.createDiv("dida-task-right-buttons");

                const titleSpan = leftContent.createEl("span", { cls: "dida-task-title dida-task-title-clickable dida-note-sync-record-title" });
                titleSpan.setText(record.title || record.path);
                const metaText = this.getNoteRecordMeta(record, fileMissing);
                if (metaText) {
                    leftContent.createDiv({
                        cls: "dida-note-sync-record-meta",
                        text: metaText
                    });
                }

                const timeSpan = rightButtons.createEl("span", { cls: "dida-task-due-date" });
                timeSpan.textContent = this.formatNoteRecordTime(record.remoteModifiedTime || record.lastSyncedAt);

                const syncStatusSpan = rightButtons.createEl("span", { cls: `dida-sync-status ${status}` });
                syncStatusSpan.title = fileMissing
                    ? "本地 Markdown 文件不存在"
                    : record.status === "missing" || record.remoteMissing
                        ? "远端笔记已不存在"
                        : record.status === "conflict"
                            ? "需要手动合并"
                            : record.status === "error"
                                ? (record.error || "同步失败")
                                : "已同步";
                setIconElement(syncStatusSpan, status === "synced" ? "cloud-check" : "cloud-alert");

                item.onclick = async () => {
                    const currentFile = record.path ? this.plugin.app.vault.getAbstractFileByPath(record.path) : null;
                    if (currentFile) {
                        await this.plugin.app.workspace.getLeaf(false).openFile(currentFile as any);
                    } else {
                        new Notice("文件不存在");
                    }
                };
                item.addEventListener("contextmenu", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.openNoteContextMenu(record, event);
                });
            });
        });
        renderFooter();
    }

    openNoteContextMenu(record: DidaNoteSyncRecord, event: MouseEvent) {
        const file = record.path ? this.plugin.app.vault.getAbstractFileByPath(record.path) : null;
        const hasDuplicateLocalFiles = this.isDuplicateLocalFileRecord(record);
        const menu = new Menu();
        menu.setUseNativeMenu(false);
        menu.addItem((item) => {
            item.setTitle(file ? "打开 Markdown" : "本地 Markdown 不存在")
                .setIcon("file-text")
                .setDisabled(!file)
                .onClick(async () => {
                    const currentFile = record.path ? this.plugin.app.vault.getAbstractFileByPath(record.path) : null;
                    if (!currentFile) {
                        new Notice("文件不存在");
                        return;
                    }
                    await this.plugin.app.workspace.getLeaf(false).openFile(currentFile as any);
                });
        });
        menu.addItem((item) => {
            item.setTitle(hasDuplicateLocalFiles ? "检测到重复文件，暂不可执行远程覆盖" : "以远程版本覆盖本地")
                .setIcon("cloud-download")
                .setDisabled(hasDuplicateLocalFiles)
                .onClick(async () => {
                    await this.handleNoteRecordForcePull(record);
                });
        });
        menu.addItem((item) => {
            item.setTitle(
                hasDuplicateLocalFiles
                    ? "检测到重复文件，暂不可执行本地上传"
                    : file ? "以上本地版本更新远程" : "本地文件不存在，无法执行上传"
            )
                .setIcon("cloud-upload")
                .setDisabled(!file || hasDuplicateLocalFiles)
                .onClick(async () => {
                    await this.handleNoteRecordForcePush(record);
                });
        });
        menu.addItem((item) => {
            item.setTitle("移除同步记录")
                .setIcon("trash")
                .onClick(async () => {
                    if (!window.confirm(`移除“${record.title || record.path}”的同步记录？此操作不会删除本地文件或远程笔记。`)) return;
                    const deleted = await this.plugin.noteSyncManager.deleteLocalRecord(record.didaId);
                    if (deleted) {
                        new Notice("同步记录已移除");
                        this.renderTaskList();
                    }
                });
        });
        menu.showAtMouseEvent(event);
    }

    formatNoteRecordTime(value: string | null | undefined) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }

    getNoteSyncRunIssueCount(lastRun: DidaNoteSyncRunState) {
        return lastRun.conflicts + lastRun.errors.length + lastRun.missing;
    }

    getNoteSyncRunUpdatedCount(lastRun: DidaNoteSyncRunState) {
        return lastRun.synced + lastRun.pushed;
    }

    getNoteRecordMeta(record: DidaNoteSyncRecord, fileMissing: boolean) {
        if (fileMissing) return "本地 Markdown 文件不存在";
        if (record.status === "conflict") return record.error || "本地与远程版本同时更新，可通过右键菜单选择处理方式。";
        if (record.status === "missing" || record.remoteMissing) return record.error || "远端笔记已不存在";
        if (record.status === "error") return record.error || "同步失败";
        return "";
    }

    isDuplicateLocalFileRecord(record: DidaNoteSyncRecord) {
        return typeof record.error === "string" && record.error.includes("多个本地 Markdown");
    }

    async handleNoteRecordForcePull(record: DidaNoteSyncRecord) {
        if (!window.confirm(`用云端笔记覆盖本地“${record.title || record.path}”？本地未同步修改会丢失。`)) return;
        try {
            const pulled = await this.plugin.noteSyncManager.forcePullRecord(record.didaId);
            new Notice(pulled ? "已从云端覆盖本地" : "云端不存在，已标记缺失");
            this.renderTaskList();
        } catch (error: any) {
            new Notice(error?.message || "拉取失败");
        }
    }

    async handleNoteRecordForcePush(record: DidaNoteSyncRecord) {
        if (!window.confirm(`用本地 Markdown 覆盖云端笔记“${record.title || record.path}”？云端未同步修改会丢失。`)) return;
        try {
            await this.plugin.noteSyncManager.forcePushRecord(record.didaId);
            new Notice("已从本地覆盖云端");
            this.renderTaskList();
        } catch (error: any) {
            new Notice(error?.message || "推送失败");
        }
    }

    // ... methods to be continued or implemented ...
    // Note: Due to size, I will implement core methods here.
    // toggleViewMode, renderTimeBlockView, etc. will be needed.

    toggleViewMode() {
        this.viewMode = this.viewMode === "task" ? "timeblock" : "task";
        this.renderTaskList();
    }

    renderTimeBlockView(container: HTMLElement) {
        container.empty();
        container.addClass("dida-time-block-view");
        if (!this.selectedDate) this.selectedDate = getTimeGridDay(new Date(), this.plugin.settings.timeBlockStartHour || 0);
        this.calendarDisplayDate = new Date(this.selectedDate);
        this.renderCalendarToolbar(container);
        if (this.calendarMode === "month") {
            this.renderCalendarMonthView(container);
            return;
        }
        if (this.calendarMode === "year") {
            this.renderCalendarYearView(container);
            return;
        }
        this.renderTimeBlockDateSelector(container);
        this.renderTimeBlocks(container);
    }

    renderCalendarToolbar(container: HTMLElement) {
        const toolbar = container.createDiv("dida-calendar-toolbar");
        const modeGroup = toolbar.createDiv("dida-calendar-mode-group");
        const modes: { value: CalendarMode; label: string }[] = [
            { value: "day", label: "日" },
            { value: "month", label: "月" },
            { value: "year", label: "年" }
        ];

        modes.forEach((mode) => {
            const button = modeGroup.createEl("button", {
                text: mode.label,
                cls: "dida-calendar-mode-btn"
            });
            button.classList.toggle("is-active", this.calendarMode === mode.value);
            button.onclick = async () => {
                this.calendarMode = mode.value;
                this.plugin.settings.defaultCalendarMode = mode.value;
                await this.plugin.saveSettings();
                this.renderTaskList();
            };
        });

        const completedLabel = toolbar.createEl("label", {
            cls: "dida-calendar-completed-toggle"
        });
        const completedInput = completedLabel.createEl("input", { type: "checkbox" });
        completedInput.checked = this.showCompletedInCalendar;
        completedLabel.createEl("span", { text: "显示已完成" });
        completedInput.onchange = async () => {
            this.showCompletedInCalendar = completedInput.checked;
            this.plugin.settings.defaultShowCompletedInCalendar = this.showCompletedInCalendar;
            await this.plugin.saveSettings();
            if (this.showCompletedInCalendar && (this.calendarMode === "month" || this.calendarMode === "year")) {
                this.calendarCompletedMonthKey = "";
                void this.ensureCalendarCompletedTasks();
            }
            this.renderTaskList();
        };
    }

    getCalendarCompletedRange() {
        if (this.calendarMode === "year") {
            const range = getCalendarYearRange(this.calendarDisplayDate);
            return {
                ...range,
                key: String(range.startDate.getFullYear())
            };
        }
        const range = getCalendarMonthRange(this.calendarDisplayDate);
        return {
            ...range,
            key: `${range.startDate.getFullYear()}-${String(range.startDate.getMonth() + 1).padStart(2, "0")}`
        };
    }

    hasCalendarCompletedCacheForRange(range: { startDate: Date; endDate: Date }) {
        return hasCalendarCompletedCacheForRange(
            range,
            this.plugin.settings.completedTaskCacheSegments
        );
    }

    shouldFetchCalendarCompletedTasks() {
        const range = this.getCalendarCompletedRange();

        const decision = getCalendarCompletedFetchDecision({
            showCompletedInCalendar: this.showCompletedInCalendar,
            calendarCompletedLoading: this.calendarCompletedLoading,
            accessToken: this.plugin.settings.accessToken,
            range,
            calendarCompletedRangeKey: this.calendarCompletedMonthKey,
            calendarCompletedError: this.calendarCompletedError,
            completedTaskCacheSegments: this.plugin.settings.completedTaskCacheSegments
        });

        if (decision.shouldMarkRangeKey) {
            this.calendarCompletedMonthKey = range.key;
        }

        return decision.shouldFetch;
    }

    async ensureCalendarCompletedTasks() {
        const range = this.getCalendarCompletedRange();
        if (!this.shouldFetchCalendarCompletedTasks()) return;

        this.calendarCompletedLoading = true;
        this.calendarCompletedError = "";
        this.renderTaskList();
        try {
            const { truncatedSegments } = await this.plugin.ensureCompletedTasksRangeCached({
                startDate: range.startDate,
                endDate: range.endDate
            });
            this.calendarCompletedMonthKey = range.key;
            if (truncatedSegments.length > 0) {
                new Notice("部分单日已完成任务达到 200 条上限，日历结果可能仍不完整");
            }
        } catch (error) {
            this.calendarCompletedError = error instanceof Error ? error.message : "已完成任务刷新失败";
            new Notice(this.calendarCompletedError);
        } finally {
            this.calendarCompletedLoading = false;
            this.renderTaskList();
        }
    }

    renderTimeBlockDateSelector(container: HTMLElement) {
        const selector = container.createDiv("dida-time-block-date-selector");
        const current = new Date(this.selectedDate!);
        current.setHours(0, 0, 0, 0);

        // Calculate week number
        const onejan = new Date(current.getFullYear(), 0, 1);
        const weekNum = Math.ceil((((current.getTime() - onejan.getTime()) / 86400000) + onejan.getDay() + 1) / 7);

        const weekDays = ["一", "二", "三", "四", "五", "六", "日"];

        const header = selector.createDiv("dida-time-block-month-header");
        const titleDiv = header.createDiv("dida-time-block-month-title");

        titleDiv.createEl("span", {
            text: (current.getMonth() + 1).toString().padStart(1, "0") + "月",
            cls: "dida-time-block-month-text"
        });

        titleDiv.createEl("span", {
            text: " " + current.getFullYear(),
            cls: "dida-time-block-year-text"
        });

        titleDiv.createEl("span", {
            text: `  第${weekNum}周`,
            cls: "dida-time-block-week-number-text"
        });

        const controls = header.createDiv("dida-time-block-month-controls");

        controls.createEl("button", {
            text: "‹",
            cls: "dida-timeline-nav-btn"
        }).onclick = () => {
            this.selectedDate!.setDate(this.selectedDate!.getDate() - 7);
            this.renderTaskList();
        };

        controls.createEl("button", {
            text: "今天",
            cls: "dida-timeline-expand-btn"
        }).onclick = () => {
            this.selectedDate = getTimeGridDay(new Date(), this.plugin.settings.timeBlockStartHour || 0);
            this.renderTaskList();
        };

        controls.createEl("button", {
            text: "›",
            cls: "dida-timeline-nav-btn"
        }).onclick = () => {
            this.selectedDate!.setDate(this.selectedDate!.getDate() + 7);
            this.renderTaskList();
        };

        const weekContainer = selector.createDiv("dida-time-block-date-nav").createDiv("dida-time-block-week");

        // Calculate start of week (Monday)
        const day = current.getDay();
        const diff = current.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(current.setDate(diff));

        for (let i = 0; i < 7; i++) {
            const date = new Date(monday);
            date.setDate(monday.getDate() + i);

            const dayDiv = weekContainer.createDiv("dida-time-block-week-day");
            dayDiv.createDiv("dida-time-block-weekday").textContent = weekDays[i];
            dayDiv.createDiv("dida-time-block-date").textContent = String(date.getDate());

            const tasks = this.getTasksForTimeBlockDate(date);
            const totalTasks = tasks.length;

            if (totalTasks > 0) {
                const completedTasks = tasks.filter(t => t.status === 2 || (t.completedTime && String(t.completedTime).trim() !== ""));
                const incompleteTasks = tasks.filter(t => !completedTasks.includes(t));

                const taskCountDiv = dayDiv.createDiv("dida-timeline-task-count");
                const maxDots = 10;

                if (totalTasks > 10) {
                    taskCountDiv.createEl("span", {
                        text: "+" + totalTasks,
                        cls: "dida-timeline-task-more"
                    }).title = totalTasks + " 个任务";
                } else {
                    const rows = Math.ceil(Math.min(totalTasks, maxDots) / 5);
                    let pendingCount = Math.min(incompleteTasks.length, maxDots);
                    let doneCount = Math.min(completedTasks.length, Math.max(0, maxDots - pendingCount));

                    for (let r = 0; r < rows; r++) {
                        const rowDiv = taskCountDiv.createDiv("dida-timeline-task-dots-row");
                        const start = r * 5;
                        const end = Math.min(start + 5, Math.min(totalTasks, maxDots));

                        for (let k = start; k < end; k++) {
                            let cls = "dida-timeline-task-dot";
                            if (pendingCount > 0) {
                                pendingCount--;
                            } else if (doneCount > 0) {
                                doneCount--;
                                cls += " dida-timeline-task-dot-completed";
                            }
                            rowDiv.createEl("span", { text: "•", cls: cls });
                        }
                    }
                    taskCountDiv.title = totalTasks + " 个任务";
                }
            }

            if (date.getFullYear() === this.selectedDate!.getFullYear() &&
                date.getMonth() === this.selectedDate!.getMonth() &&
                date.getDate() === this.selectedDate!.getDate()) {
                dayDiv.addClass("is-selected");
            }

            dayDiv.onclick = () => {
                this.selectedDate = new Date(date);
                this.renderTaskList();
            };
        }
    }

    getTasksForTimeBlockDate(date: Date): any[] {
        const tasks = this.plugin.settings.tasks || [];
        const startHour = this.plugin.settings.timeBlockStartHour || 0;
        return tasks.filter(task => this.plugin.isTaskListItem(task) && taskBelongsToTimeGridDate(task, date, startHour));
    }

    getCalendarTasksForRange(range = getCalendarMonthRange(this.calendarDisplayDate)) {
        const localTasks = (this.plugin.settings.tasks || [])
            .map((task, index) => task ? { ...task, originalIndex: index } : task)
            .filter((task) => {
                if (!task) return false;
                if (!this.plugin.isTaskListItem(task)) return false;
                if (!this.showCompletedInCalendar && task.status === 2) return false;
                const projectInfo = this.plugin.resolveTaskProjectInfo(task);
                if (!this.plugin.settings.showArchivedProjects && projectInfo.isArchived) return false;
                if (!this.plugin.isProjectVisible(projectInfo.id, projectInfo.name)) return false;
                const rawDate = task.status === 2 ? task.completedTime || task.startDate || task.dueDate : task.startDate || task.dueDate;
                if (!rawDate) return false;
                const date = new Date(rawDate);
                if (Number.isNaN(date.getTime())) return false;
                if (task.status !== 2 && (date.getTime() < range.startDate.getTime() || date.getTime() > range.endDate.getTime())) return false;
                return true;
            });

        const pendingTasks = localTasks.filter((task) => task.status !== 2);
        const completedTasks = this.showCompletedInCalendar
            ? dedupeCalendarTasks([
                ...localTasks.filter((task) => task.status === 2),
                ...((this.plugin.settings.completedTasks || []) as DidaTask[])
            ]).filter((task) => {
                if (!task) return false;
                const projectInfo = this.plugin.resolveTaskProjectInfo(task);
                if (!this.plugin.settings.showArchivedProjects && projectInfo.isArchived) return false;
                if (!this.plugin.isProjectVisible(projectInfo.id, projectInfo.name)) return false;
                const completedAt = task.completedTime ? new Date(task.completedTime) : null;
                if (!completedAt || Number.isNaN(completedAt.getTime())) return false;
                return completedAt.getTime() >= range.startDate.getTime() && completedAt.getTime() <= range.endDate.getTime();
            })
            : [];

        return {
            pending: groupTasksByCalendarDate(pendingTasks as DidaTask[]),
            completed: groupTasksByCalendarDate(completedTasks, true)
        };
    }

    renderCalendarMonthView(container: HTMLElement) {
        const monthContainer = container.createDiv("dida-calendar-month-view");
        const range = getCalendarMonthRange(this.calendarDisplayDate);
        if (this.shouldFetchCalendarCompletedTasks()) {
            void this.ensureCalendarCompletedTasks();
        }

        const header = monthContainer.createDiv("dida-calendar-month-header");
        const monthTitle = header.createDiv("dida-calendar-month-title");
        monthTitle.createEl("span", {
            text: `${this.calendarDisplayDate.getMonth() + 1}月`,
            cls: "dida-time-block-month-text"
        });
        monthTitle.createEl("span", {
            text: ` ${this.calendarDisplayDate.getFullYear()}`,
            cls: "dida-time-block-year-text"
        });
        const controls = header.createDiv("dida-calendar-month-controls");
        controls.createEl("button", { text: "‹", cls: "dida-timeline-nav-btn" }).onclick = () => {
            this.calendarDisplayDate = new Date(this.calendarDisplayDate.getFullYear(), this.calendarDisplayDate.getMonth() - 1, 1);
            this.selectedDate = new Date(this.calendarDisplayDate);
            this.renderTaskList();
        };
        controls.createEl("button", { text: "今天", cls: "dida-timeline-expand-btn" }).onclick = () => {
            this.selectedDate = getTimeGridDay(new Date(), this.plugin.settings.timeBlockStartHour || 0);
            this.calendarDisplayDate = new Date(this.selectedDate);
            this.renderTaskList();
        };
        controls.createEl("button", { text: "›", cls: "dida-timeline-nav-btn" }).onclick = () => {
            this.calendarDisplayDate = new Date(this.calendarDisplayDate.getFullYear(), this.calendarDisplayDate.getMonth() + 1, 1);
            this.selectedDate = new Date(this.calendarDisplayDate);
            this.renderTaskList();
        };

        if (this.calendarCompletedLoading) {
            monthContainer.createDiv("dida-calendar-status").textContent = "正在刷新已完成任务...";
        } else if (this.calendarCompletedError) {
            monthContainer.createDiv("dida-calendar-status dida-calendar-status-error").textContent = `已完成任务未刷新：${this.calendarCompletedError}`;
        }

        const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
        const weekdayRow = monthContainer.createDiv("dida-calendar-weekday-row");
        weekdays.forEach((day) => weekdayRow.createDiv("dida-calendar-weekday-cell").textContent = day);

        const grid = monthContainer.createDiv("dida-calendar-month-grid");
        const grouped = this.getCalendarTasksForRange(range);
        const todayKey = getCalendarDateKey(new Date());
        const selectedKey = this.selectedDate ? getCalendarDateKey(this.selectedDate) : "";

        buildCalendarMonthGrid(this.calendarDisplayDate).forEach((cell) => {
            const cellEl = grid.createDiv("dida-calendar-month-cell");
            if (!cell.inCurrentMonth) cellEl.addClass("is-outside-month");
            if (cell.key === todayKey) cellEl.addClass("is-today");
            if (cell.key === selectedKey) cellEl.addClass("is-selected");

            const dateHeader = cellEl.createDiv("dida-calendar-cell-date");
            dateHeader.textContent = String(cell.date.getDate());
            dateHeader.onclick = () => {
                this.selectedDate = new Date(cell.date);
                this.calendarDisplayDate = new Date(cell.date);
                this.calendarMode = "day";
                this.renderTaskList();
            };

            const taskList = cellEl.createDiv("dida-calendar-cell-tasks");
            const tasks = [
                ...(grouped.pending.get(cell.key) || []).map((task) => ({ task, completed: false })),
                ...(grouped.completed.get(cell.key) || []).map((task) => ({ task, completed: true }))
            ];
            const visibleTasks = tasks.slice(0, 4);
            visibleTasks.forEach(({ task, completed }) => this.renderCalendarTaskChip(taskList, task, completed));
            if (tasks.length > visibleTasks.length) {
                taskList.createDiv("dida-calendar-task-more").textContent = `+${tasks.length - visibleTasks.length}`;
            }
        });
    }

    renderCalendarYearView(container: HTMLElement) {
        const yearContainer = container.createDiv("dida-calendar-year-view");
        const range = getCalendarYearRange(this.calendarDisplayDate);
        if (this.shouldFetchCalendarCompletedTasks()) {
            void this.ensureCalendarCompletedTasks();
        }

        const header = yearContainer.createDiv("dida-calendar-year-header");
        const yearTitle = header.createDiv("dida-calendar-year-title");
        yearTitle.createEl("span", {
            text: `${this.calendarDisplayDate.getFullYear()}`,
            cls: "dida-calendar-year-title-number"
        });
        yearTitle.createEl("span", {
            text: "年",
            cls: "dida-calendar-year-title-suffix"
        });
        const controls = header.createDiv("dida-calendar-month-controls");
        controls.createEl("button", { text: "‹", cls: "dida-timeline-nav-btn" }).onclick = () => {
            this.calendarDisplayDate = new Date(this.calendarDisplayDate.getFullYear() - 1, 0, 1);
            this.selectedDate = new Date(this.calendarDisplayDate);
            this.renderTaskList();
        };
        controls.createEl("button", { text: "今天", cls: "dida-timeline-expand-btn" }).onclick = () => {
            this.selectedDate = getTimeGridDay(new Date(), this.plugin.settings.timeBlockStartHour || 0);
            this.calendarDisplayDate = new Date(this.selectedDate);
            this.renderTaskList();
        };
        controls.createEl("button", { text: "›", cls: "dida-timeline-nav-btn" }).onclick = () => {
            this.calendarDisplayDate = new Date(this.calendarDisplayDate.getFullYear() + 1, 0, 1);
            this.selectedDate = new Date(this.calendarDisplayDate);
            this.renderTaskList();
        };

        if (this.calendarCompletedLoading) {
            yearContainer.createDiv("dida-calendar-status").textContent = "正在刷新已完成任务...";
        } else if (this.calendarCompletedError) {
            yearContainer.createDiv("dida-calendar-status dida-calendar-status-error").textContent = `已完成任务未刷新：${this.calendarCompletedError}`;
        }

        const grouped = this.getCalendarTasksForRange(range);
        const todayKey = getCalendarDateKey(new Date());
        const selectedKey = this.selectedDate ? getCalendarDateKey(this.selectedDate) : "";
        const monthNames = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
        const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
        const monthsGrid = yearContainer.createDiv("dida-calendar-year-grid");

        for (let month = 0; month < 12; month++) {
            const monthDate = new Date(this.calendarDisplayDate.getFullYear(), month, 1);
            const monthEl = monthsGrid.createDiv("dida-calendar-year-month");
            const title = monthEl.createDiv("dida-calendar-year-month-title");
            title.textContent = monthNames[month];
            title.onclick = () => {
                this.calendarDisplayDate = new Date(monthDate);
                this.selectedDate = new Date(monthDate);
                this.calendarMode = "month";
                this.renderTaskList();
            };

            const weekdayRow = monthEl.createDiv("dida-calendar-year-weekdays");
            weekdays.forEach((day) => weekdayRow.createDiv("dida-calendar-year-weekday").textContent = day);

            const daysGrid = monthEl.createDiv("dida-calendar-year-days");
            buildCalendarMonthGrid(monthDate, "sunday").forEach((cell) => {
                const pendingCount = (grouped.pending.get(cell.key) || []).length;
                const completedCount = (grouped.completed.get(cell.key) || []).length;
                const dayEl = daysGrid.createDiv("dida-calendar-year-day");
                dayEl.textContent = String(cell.date.getDate());
                if (!cell.inCurrentMonth) dayEl.addClass("is-outside-month");
                if (cell.key === todayKey) dayEl.addClass("is-today");
                if (cell.key === selectedKey) dayEl.addClass("is-selected");
                const totalCount = pendingCount + completedCount;
                if (pendingCount > 0) dayEl.addClass("has-pending");
                if (completedCount > 0) dayEl.addClass("has-completed");
                if (totalCount > 0) {
                    dayEl.addClass(`heat-${Math.min(4, totalCount)}`);
                }
                if (totalCount > 0) {
                    dayEl.title = `${pendingCount} 个未完成，${completedCount} 个已完成`;
                }
                dayEl.onclick = () => {
                    this.selectedDate = new Date(cell.date);
                    this.calendarDisplayDate = new Date(cell.date);
                    this.calendarMode = "day";
                    this.renderTaskList();
                };
            });
        }
    }

    renderCalendarTaskChip(container: HTMLElement, task: DidaTask, completed: boolean) {
        const chip = container.createDiv(completed ? "dida-calendar-task-chip is-completed" : "dida-calendar-task-chip");
        chip.setCssStyles({ backgroundColor: completed ? "" : this.getTaskColor(task) });
        if (task.parentId) chip.addClass("is-subtask");
        chip.title = this.getTaskPathLabel(task);
        chip.textContent = `${task.parentId ? "↳ " : ""}${task.title || "未命名任务"}`;
        chip.onclick = (event) => {
            event.stopPropagation();
            if (this.resolveTaskOriginalIndex(task) !== -1) {
                this.toggleTaskDetails(chip, task);
            } else {
                new Notice("这条已完成任务来自远端记录，当前只能在月历中查看");
            }
        };
    }

    isAllDayTask(task: any): boolean {
        return isAllDayTimeGridTask(task);
    }

    renderTimeBlocks(container: HTMLElement) {
        const blockContainer = container.createDiv("dida-time-block-container");
        const tasks = this.getTasksForTimeBlockDate(this.selectedDate!);

        const allDayTasks = tasks.filter(t => this.isAllDayTask(t));
        const timeTasks = tasks.filter(t => !this.isAllDayTask(t));

        if (allDayTasks.length > 0) {
            this.renderAllDayBlocks(blockContainer, allDayTasks);
        }

        if (tasks.length === 0) {
            blockContainer.createDiv("dida-timeline-empty-state").createEl("p", { text: "今天没有任务" });
        }

        this.renderTimeGrid(blockContainer, timeTasks);

    }

    renderAllDayBlocks(container: HTMLElement, tasks: any[]) {
        const section = container.createDiv("dida-time-block-all-day-section");
        const grid = section.createDiv("dida-time-block-all-day-grid");

        tasks.forEach(task => {
            const item = grid.createDiv("dida-time-block-item dida-time-block-all-day");
            item.setAttribute("data-task-id", task.id);
            item.setAttribute("draggable", "true");
            item.setCssStyles({ backgroundColor: this.getTaskColor(task) });

            item.addEventListener("dragstart", (e) => {
                const target = e.target as HTMLElement;
                if (target && target.isContentEditable) {
                    e.preventDefault();
                    return;
                }
                if (e.dataTransfer) {
                    e.dataTransfer.setData("text/plain", task.id);
                    e.dataTransfer.effectAllowed = "move";
                }
                item.classList.add("dragging");
            });

            item.addEventListener("dragend", () => {
                item.classList.remove("dragging");
            });

            const checkbox = item.createEl("input", { type: "checkbox" });
            checkbox.checked = task.status === 2;
            checkbox.onchange = async () => {
                const idx = this.resolveTaskOriginalIndex(task);
                if (idx !== -1) {
                    await this.plugin.toggleTask(idx);
                    this.renderTaskList();
                } else {
                    new Notice("未找到对应任务，无法切换完成状态");
                }
            };

            const titleStack = item.createDiv("dida-time-block-task-text");
            const titleSpan = titleStack.createEl("span", {
                cls: task.status === 2 ? "dida-task-completed" : "dida-task-title"
            });
            this.renderTaskTitleContent(titleSpan, task.title || "");
            const parentLabel = this.getTaskParentLabel(task);
            if (parentLabel) {
                titleStack.createEl("span", {
                    cls: "dida-time-block-parent-label",
                    text: `↳ ${parentLabel}`
                });
            }

            // Edit title logic
            titleSpan.contentEditable = "false";
            titleSpan.setCssStyles({ outline: "none", wordBreak: "break-word", cursor: "pointer" });

            let originalTitle = task.title;

            titleSpan.onclick = (e) => {
                e.stopPropagation();
                if (titleSpan.contentEditable !== "true") {
                    titleSpan.contentEditable = "true";
                    titleSpan.setCssStyles({ cursor: "text" });
                    titleSpan.focus();
                }
            };

            titleSpan.onfocus = () => { originalTitle = titleSpan.textContent; };
            titleSpan.onblur = async () => {
                titleSpan.contentEditable = "false";
                titleSpan.setCssStyles({ cursor: "pointer" });
                const newTitle = titleSpan.textContent?.trim();
                if (newTitle && newTitle !== originalTitle) {
                    const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                    if (idx !== -1) {
                        const t = this.plugin.settings.tasks[idx];
                        const oldTitle = t.title;
                        t.title = newTitle;
                        t.updatedAt = new Date().toISOString();
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.accessToken && t.didaId) {
                            this.plugin.updateTaskInDidaList(t);
                        }
                        if (t.didaId) {
                            // Update native task title if linked
                            // this.plugin.updateNativeTaskTitle(t, oldTitle, newTitle); // Need to implement this in plugin or here
                        }
                        this.renderTaskList();
                    }
                } else {
                    titleSpan.textContent = originalTitle || "";
                }
            };

            titleSpan.onkeydown = (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    titleSpan.blur();
                }
            };

            // Due Date
            const dateSpan = item.createEl("span", {
                cls: "dida-task-due-date"
            });
            dateSpan.setCssStyles({ marginLeft: "auto", marginRight: "10px" });

            if (task.startDate) {
                try {
                    const date = new Date(task.startDate);
                    const month = date.getMonth() + 1;
                    const day = date.getDate();
                    dateSpan.textContent = `${month}/${day}`;

                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    date.setHours(0, 0, 0, 0);

                    if (date < today) dateSpan.classList.add("overdue");
                    else if (date.getTime() === today.getTime()) dateSpan.classList.add("today");
                } catch (e) {
                    dateSpan.textContent = "";
                }
            } else {
                setIconElement(dateSpan, "calendar-x-2");
                dateSpan.classList.add("no-date");
            }

            dateSpan.addClass("dida-clickable-date");
            dateSpan.title = "点击设置时间";
            dateSpan.onclick = (e) => {
                e.stopPropagation();
                const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                if (idx !== -1) {
                    const date = task.startDate || task.dueDate || this.selectedDate;
                    new DatePickerModal(this.app, date, async (d, isAllDay, endDate, repeatFlag) => {
                        await this.updateTaskSchedule(idx, d, isAllDay, endDate, repeatFlag);
                    }, e.currentTarget as HTMLElement, this.plugin, idx).open();
                }
            };

            const deleteBtn = item.createEl("button", { cls: "dida-task-delete" });
            setIconElement(deleteBtn, "x");
            deleteBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (confirm(`确定要删除任务"${task.title}"吗？`)) {
                    const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                    if (idx !== -1) await this.plugin.deleteTask(idx);
                }
            };

            item.onclick = (e) => {
                if (e.target !== checkbox && e.target !== titleSpan && e.target !== deleteBtn && !deleteBtn.contains(e.target as Node)) {
                    e.stopPropagation();
                    const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                    if (idx !== -1) {
                        const date = task.startDate || task.dueDate || this.selectedDate;
                        new DatePickerModal(this.app, date, async (d, isAllDay, endDate, repeatFlag) => {
                            await this.updateTaskSchedule(idx, d, isAllDay, endDate, repeatFlag);
                        }, item, this.plugin, idx).open();
                    }
                }
            };
        });
    }

    calculateMinutesFromY(clientY: number, gridRect: DOMRect, startHour: number = 0): number {
        const topY = Math.max(gridRect.top, Math.min(gridRect.bottom, clientY));
        const relativeTop = topY - gridRect.top;
        const topPct = (relativeTop / gridRect.height) * 100;
        return gridStartMinutes((topPct / 100) * 1440, startHour);
    }

    async handleTaskTimeRescheduling(taskId: string, newStartDate: Date, newEndDate: Date) {
        const idx = this.plugin.settings.tasks.findIndex(t => t.id === taskId || t.didaId === taskId);
        if (idx === -1) return;

        const task = this.plugin.settings.tasks[idx];

        task.isAllDay = false;
        task.startDate = newStartDate.toISOString();
        task.dueDate = newEndDate.toISOString();
        task.updatedAt = new Date().toISOString();
        task.status = 0;

        await this.plugin.saveSettings();

        if (this.plugin.settings.accessToken && task.didaId) {
            this.plugin.updateTaskInDidaList(task).catch(console.error);
        }

        this.renderTaskList();
    }

    renderTimeGrid(container: HTMLElement, tasks: any[]) {
        const timeSection = container.createDiv("dida-time-block-time-section");
        const grid = timeSection.createDiv("dida-time-block-time-grid");
        const startHour = this.plugin.settings.timeBlockStartHour || 0;

        for (let i = 0; i < 24; i++) {
            const hour = (startHour + i) % 24;
            const hourDiv = grid.createDiv("dida-time-block-hour");
            hourDiv.createDiv("dida-time-block-hour-label").textContent = hour.toString().padStart(2, "0") + ":00";
            hourDiv.createDiv("dida-time-block-hour-line");
            for (let quarter = 1; quarter < 4; quarter++) {
                const line = hourDiv.createDiv("dida-time-block-quarter-line");
                line.setCssStyles({ top: `${quarter * 25}%` });
            }
        }

        // Current time line
        const now = new Date();
        const gridRange = getTimeGridRange(this.selectedDate!, startHour);

        if (now.getTime() >= gridRange.start.getTime() && now.getTime() < gridRange.end.getTime()) {
            const topPercent = ((now.getTime() - gridRange.start.getTime()) / (gridRange.end.getTime() - gridRange.start.getTime())) * 100;

            const line = grid.createDiv("dida-time-block-now-line");
            line.setCssStyles({ top: topPercent + "%" });
        }

        // Handle Drag and Drop for scheduling "All Day" tasks
        grid.addEventListener("dragover", (e) => {
            e.preventDefault(); // allow drop
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = "move";
            }
        });

        grid.addEventListener("drop", async (e) => {
            e.preventDefault();
            const taskId = e.dataTransfer?.getData("text/plain");
            if (!taskId) return;

            const rect = grid.getBoundingClientRect();
            const startMins = this.calculateMinutesFromY(e.clientY, rect, startHour);
            const endMins = startMins + 60; // Default 1 hour duration
            const sDate = dateAtMinutes(this.selectedDate!, startMins);
            const eDate = dateAtMinutes(this.selectedDate!, endMins);

            await this.handleTaskTimeRescheduling(taskId, sDate, eDate);
        });

        // Mouse events for creating tasks
        grid.addEventListener("mousedown", (e) => {
            if (e.button !== 0 || (e.target as HTMLElement).closest(".dida-time-block-task")) return;

            const rect = grid.getBoundingClientRect();
            const height = grid.offsetHeight;
            if (!height) return;

            const startY = e.clientY;
            const offsetX = 50; // Label width approx
            const gridLeft = rect.left + offsetX;
            const colWidth = (rect.right - gridLeft) / 2; // Assuming 2 columns max for simplicity or dynamic?
            // Source logic for columns: `n = e.clientX < i + (g.right - i) / 2 ? 0 : 1`
            // It splits grid into 2 columns for creation?

            const clickX = e.clientX;
            const column = clickX < gridLeft + (rect.width - offsetX) / 2 ? 0 : 1;

            let isDragging = false;
            let tempTask: HTMLElement | null = null;
            let timeLabel: HTMLElement | null = null;
            let titleInput: HTMLElement | null = null;

            const cleanup = () => {
                if (tempTask && tempTask.parentElement) tempTask.remove();
                tempTask = null;
                isDragging = false;
            };

            const createTask = async () => {
                if (isDragging && tempTask && titleInput) {
                    const title = titleInput.textContent?.trim();
                    if (title) {
                        const topPct = (tempTask.offsetTop / height) * 100;
                        const heightPct = (tempTask.offsetHeight / height) * 100;
                        const startMins = gridStartMinutes((topPct / 100) * 1440, startHour);
                        const durationMins = snapDuration((heightPct / 100) * 1440);
                        const endMins = Math.min(startHour * 60 + 1440, startMins + durationMins);

                        const sDate = dateAtMinutes(this.selectedDate!, startMins);
                        const eDate = dateAtMinutes(this.selectedDate!, endMins);

                        const newTask: DidaTask = {
                            id: Date.now().toString(),
                            title: title,
                            content: "",
                            desc: "",
                            completed: false,
                            status: 0,
                            didaId: null,
                            projectId: "inbox",
                            projectName: "收集箱",
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            items: [],
                            startDate: sDate.toISOString(),
                            dueDate: eDate.toISOString(),
                            isAllDay: false,
                            kind: "TEXT",
                            priority: 0,
                            sortOrder: 0,
                            timeZone: this.plugin.getUserTimeZone(),
                            isFloating: false
                        };

                        this.plugin.settings.tasks.push(newTask);
                        await this.plugin.saveSettings();
                        cleanup();
                        this.renderTaskList();
                        if (this.plugin.settings.accessToken) {
                            this.plugin.createTaskInDidaList(newTask).catch(console.error);
                        }
                    } else {
                        cleanup();
                    }
                } else {
                    cleanup();
                }
            };

            const onMouseMove = (moveE: MouseEvent) => {
                const stepHeight = height / (1440 / TIME_GRID_STEP_MINUTES);
                const snapY = (clientY: number) => rect.top + Math.round((clampMinutes(clientY - rect.top, 0, height)) / stepHeight) * stepHeight;
                const snappedStartY = snapY(startY);
                const currentY = snapY(moveE.clientY);
                const diff = currentY - startY;

                if (!isDragging && Math.abs(diff) > 5) {
                    isDragging = true;
                    tempTask = grid.createDiv("dida-time-block-task dida-time-block-temp");
                    tempTask.setCssStyles({ position: "absolute" });
                    // Column positioning
                    const effectiveWidth = rect.width - offsetX;
                    if (column === 0) {
                        tempTask.setCssStyles({ left: `${offsetX}px`, width: `calc(50% - ${offsetX / 2}px - 2.5px)` }); // Approx
                    } else {
                        tempTask.setCssStyles({ left: `calc(50% + ${offsetX / 2}px + 2.5px)`, width: `calc(50% - ${offsetX / 2}px - 2.5px)` });
                    }

                    const contentDiv = tempTask.createDiv("dida-time-block-task-content");
                    const cb = contentDiv.createEl("input", { type: "checkbox" });
                    cb.disabled = true;

                    timeLabel = contentDiv.createDiv("dida-time-block-task-time");
                    titleInput = contentDiv.createDiv("dida-time-block-task-title");
                    titleInput.contentEditable = "true";
                    titleInput.setCssStyles({ outline: "none" });
                }

                if (isDragging && tempTask) {
                    const topY = Math.max(rect.top, Math.min(rect.bottom, Math.min(snappedStartY, currentY)));
                    const bottomY = Math.max(rect.top, Math.min(rect.bottom, Math.max(snappedStartY, currentY)));
                    const h = Math.max(stepHeight, bottomY - topY);
                    const relativeTop = topY - rect.top;

                    const topPct = (relativeTop / height) * 100;
                    const heightPct = (h / height) * 100;

                    tempTask.setCssStyles({
                        top: topPct + "%",
                        height: heightPct + "%"
                    });

                    // Update time label
                    // ... calculation ...
                    if (timeLabel) {
                        const startMins = snapMinutes((topPct / 100) * 1440 + (startHour * 60));
                        const endMins = snapMinutes(((topPct + heightPct) / 100) * 1440 + (startHour * 60));
                        const sH = Math.floor(startMins / 60) % 24;
                        const sM = startMins % 60;
                        const eH = Math.floor(endMins / 60) % 24;
                        const eM = endMins % 60;
                        timeLabel.textContent = `${String(sH).padStart(2, '0')}:${String(sM).padStart(2, '0')} - ${String(eH).padStart(2, '0')}:${String(eM).padStart(2, '0')}`;
                    }
                }
            };

            const onMouseUp = () => {
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);

                if (!isDragging || !tempTask || !titleInput) {
                    cleanup();
                    return;
                }

                const taskHeight = tempTask.offsetHeight;
                if (taskHeight < 10) { // Too small
                    cleanup();
                    return;
                }

                titleInput.focus();

                const onEnter = (kE: KeyboardEvent) => {
                    if (kE.key === "Enter") {
                        kE.preventDefault();
                        titleInput!.removeEventListener("keydown", onEnter);
                        titleInput!.removeEventListener("blur", onBlur);
                        createTask();
                    } else if (kE.key === "Escape") {
                        kE.preventDefault();
                        cleanup();
                    }
                };

                const onBlur = () => {
                    titleInput!.removeEventListener("keydown", onEnter);
                    titleInput!.removeEventListener("blur", onBlur);
                    createTask();
                };

                titleInput.addEventListener("keydown", onEnter);
                titleInput.addEventListener("blur", onBlur);
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
        });

        // Render existing tasks
        this.assignColumnsToTasks(tasks).forEach(({ task, column }) => {
            this.renderTimeTaskBlock(grid, task, column);
        });
    }

    assignColumnsToTasks(tasks: any[]): { task: any, column: number }[] {
        const sorted = tasks.slice().sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
        const result: { task: any, column: number }[] = [];
        const columns: any[][] = [[], []]; // 2 columns max

        sorted.forEach(task => {
            const start = new Date(task.startDate).getTime();
            const end = new Date(task.dueDate).getTime();

            let assigned = -1;
            for (let i = 0; i < 2; i++) {
                let collision = false;
                for (const t of columns[i]) {
                    const tStart = new Date(t.startDate).getTime();
                    const tEnd = new Date(t.dueDate).getTime();
                    if (start < tEnd && tStart < end) {
                        collision = true;
                        break;
                    }
                }
                if (!collision) {
                    assigned = i;
                    break;
                }
            }

            if (assigned !== -1) {
                columns[assigned].push(task);
                result.push({ task, column: assigned });
            } else {
                // Fallback to column 0 if both full
                result.push({ task, column: 0 });
            }
        });
        return result;
    }

    getTaskColor(task: any) {
        switch (Number(task.priority || 0)) {
            case 5:
                return "rgb(239 190 190)";
            case 3:
                return "rgb(246 226 156)";
            case 1:
                return "rgb(190 214 248)";
            default:
                return "rgb(226 226 226)";
        }
    }

    renderTimeTaskBlock(container: HTMLElement, task: any, column: number) {
        if (task.startDate && task.dueDate) {
            const start = new Date(task.startDate);
            const end = new Date(task.dueDate);
            const startHour = this.plugin.settings.timeBlockStartHour || 0;
            const startTotal = start.getHours() * 60 + start.getMinutes();
            const endTotal = end.getHours() * 60 + end.getMinutes();
            let relStart = 60 * (start.getHours() - startHour) + start.getMinutes();
            if (relStart < 0) relStart += 1440;
            const topPct = (relStart / 1440) * 100;
            let duration = endTotal - startTotal;
            if (duration < 0) duration += 1440;
            const heightPct = (duration / 1440) * 100;
            const block = container.createDiv("dida-time-block-task");
            block.setAttribute("data-task-id", task.id);
            block.setAttribute("data-column", column.toString());
            block.setCssStyles({
                top: topPct + "%",
                height: heightPct + "%",
                backgroundColor: this.getTaskColor(task)
            });
            block.setCssStyles({
                left: column === 0 ? "50px" : "calc(50% + 25px + 2.5px)",
                width: "calc(50% - 25px - 2.5px)"
            });

            const content = block.createDiv("dida-time-block-task-content");
            const cb = content.createEl("input", { type: "checkbox" });
            cb.checked = task.status === 2;
            cb.setCssStyles({ marginRight: "8px", flexShrink: "0" });
            cb.onchange = async (e) => {
                e.stopPropagation();
                const idx = this.plugin.settings.tasks.findIndex(t => task.didaId === t.didaId);
                if (idx !== -1) {
                    await this.plugin.toggleTask(idx);
                    this.renderTaskList();
                }
            };
            const timeLabel = content.createDiv("dida-time-block-task-time");
            const startLabel = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
            const endLabel = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
            timeLabel.textContent = `${startLabel} - ${endLabel}`;
            timeLabel.onclick = (e) => {
                e.stopPropagation();
                const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                if (idx !== -1) {
                    const date = task.startDate || task.dueDate || this.selectedDate;
                    new DatePickerModal(this.app, date, async (d, allDay, endDate, repeatFlag) => {
                        await this.updateTaskSchedule(idx, d, allDay, endDate, repeatFlag);
                    }, timeLabel, this.plugin, idx).open();
                }
            };

            const titleDiv = block.createDiv("dida-time-block-task-title");
            this.renderTaskTitleContent(titleDiv, task.title || "");
            const parentLabel = this.getTaskParentLabel(task);
            if (parentLabel) {
                block.createDiv({
                    cls: "dida-time-block-parent-label",
                    text: `↳ ${parentLabel}`
                });
            }
            titleDiv.contentEditable = "true";
            titleDiv.setCssStyles({
                outline: "none",
                cursor: "text",
                wordBreak: "break-word",
                textDecoration: task.status === 2 ? "line-through" : ""
            });
            let originalTitle = task.title;
            titleDiv.onfocus = () => { originalTitle = titleDiv.textContent || ""; };
            titleDiv.onblur = async () => {
                const newTitle = titleDiv.textContent?.trim() || "";
                if (newTitle && newTitle !== originalTitle) {
                    const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                    if (idx !== -1) {
                        const t = this.plugin.settings.tasks[idx];
                        const oldTitle = t.title;
                        t.title = newTitle;
                        t.updatedAt = new Date().toISOString();
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.accessToken && t.didaId) this.plugin.syncTaskToDidaListInBackground(t);
                        if (t.didaId) {
                            const leaves = this.app.workspace.getLeavesOfType(TASK_VIEW_TYPE);
                            if (leaves.length > 0 && (leaves[0].view as any).updateNativeTaskTitle) {
                                try { await (leaves[0].view as any).updateNativeTaskTitle(t, oldTitle, newTitle); } catch (e) { }
                            }
                        }
                    }
                } else if (!newTitle) {
                    titleDiv.textContent = originalTitle || "";
                }
            };
            titleDiv.onkeydown = (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    titleDiv.blur();
                }
            };

            const deleteBtn = block.createEl("button", { cls: "dida-task-delete" });
            setIconElement(deleteBtn, "x");
            deleteBtn.onclick = async (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (confirm(`确定要删除任务"${task.title}"吗？`)) {
                    const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                    if (idx !== -1) await this.plugin.deleteTask(idx);
                }
            };

            let tooltip: HTMLElement | null = null;
            let tooltipKeyHandler: ((e: KeyboardEvent) => void) | null = null;
            const hideTooltip = () => {
                if (tooltip && tooltip.parentElement) tooltip.parentElement.removeChild(tooltip);
                tooltip = null;
                if (tooltipKeyHandler) {
                    document.removeEventListener("keyup", tooltipKeyHandler);
                    tooltipKeyHandler = null;
                }
            };
            const moveTooltip = (e: MouseEvent) => {
                if (tooltip) {
                    tooltip.setCssStyles({
                        left: e.clientX + 12 + "px",
                        top: e.clientY + 12 + "px"
                    });
                }
            };
            const showTooltip = (e: MouseEvent) => {
                if (e.ctrlKey || (e as any).metaKey) {
                    if (!tooltip) {
                        const el = document.createElement("div");
                        el.className = "dida-time-block-tooltip";
                        el.textContent = `${startLabel} - ${endLabel}  ·  ${task.title || ""}`;
                        document.body.appendChild(el);
                        tooltip = el;
                        tooltipKeyHandler = (evt: KeyboardEvent) => {
                            if (!evt.ctrlKey && !(evt as any).metaKey) hideTooltip();
                        };
                        document.addEventListener("keyup", tooltipKeyHandler);
                    }
                    moveTooltip(e);
                } else {
                    hideTooltip();
                }
            };
            block.addEventListener("mouseenter", showTooltip);
            block.addEventListener("mousemove", showTooltip);
            block.addEventListener("mouseleave", hideTooltip);

            let durationMinutes = 60 * end.getHours() + end.getMinutes() - (60 * start.getHours() + start.getMinutes());
            if (durationMinutes < 0) durationMinutes += 1440;
            durationMinutes = snapDuration(durationMinutes);

            block.addEventListener("mousedown", (e) => {
                const target = e.target as HTMLElement;
                if (target !== cb && target !== titleDiv && !titleDiv.contains(target) && target !== deleteBtn && !deleteBtn.contains(target)) {
                    e.preventDefault();
                    const parent = block.parentElement;
                    if (parent) {
                        const height = parent.offsetHeight;
                        if (height) {
                            const startY = e.clientY;
                            const startTop = block.offsetTop;
                            const stepHeight = height / (1440 / TIME_GRID_STEP_MINUTES);
                            const startHeight = Math.max(stepHeight, durationMinutes / 1440 * height);
                            block.setCssStyles({ height: `${startHeight / height * 100}%` });
                            const onMove = (ev: MouseEvent) => {
                                const diff = ev.clientY - startY;
                                let newTop = Math.round((startTop + diff) / stepHeight) * stepHeight;
                                const maxTop = Math.max(0, height - startHeight);
                                if (newTop < 0) newTop = 0;
                                if (newTop > maxTop) newTop = maxTop;
                                block.setCssStyles({ top: (newTop / height) * 100 + "%" });
                                if (timeLabel && block.parentElement) {
                                    const parentHeight = block.parentElement.offsetHeight || 0;
                                    if (parentHeight > 0) {
                                        const startPct = block.offsetTop / parentHeight * 100;
                                        const endPct = (startPct + block.offsetHeight / parentHeight * 100) / 100 * 24 * 60;
                                        const startHour = this.plugin.settings.timeBlockStartHour || 0;
                                        let startMin = snapMinutes(startPct / 100 * 24 * 60 + 60 * startHour);
                                        let endMin = snapMinutes(endPct + 60 * startHour);
                                        if (startMin >= 1440) startMin -= 1440;
                                        if (endMin >= 1440) endMin -= 1440;
                                        if (startMin < 0) startMin = 0;
                                        if (endMin < 0) endMin = 0;
                                        const sh = Math.floor(startMin / 60).toString().padStart(2, "0");
                                        const sm = (startMin % 60).toString().padStart(2, "0");
                                        const eh = Math.floor(endMin / 60).toString().padStart(2, "0");
                                        const em = (endMin % 60).toString().padStart(2, "0");
                                        timeLabel.textContent = `${sh}:${sm} - ${eh}:${em}`;
                                    }
                                }
                            };
                            const onUp = async () => {
                                document.removeEventListener("mousemove", onMove);
                                document.removeEventListener("mouseup", onUp);
                                const parentHeight = parent.offsetHeight;
                                if (parentHeight) {
                                    const startPct = block.offsetTop / parentHeight * 100;
                                    const startHour = this.plugin.settings.timeBlockStartHour || 0;
                                    const startMin = gridStartMinutes(startPct / 100 * 24 * 60, startHour);
                                    const endMin = startMin + durationMinutes;
                                    const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                                    if (idx !== -1) {
                                        const startDate = dateAtMinutes(this.selectedDate!, startMin);
                                        const endDate = dateAtMinutes(this.selectedDate!, endMin);
                                        this.plugin.settings.tasks[idx].startDate = startDate.toISOString();
                                        this.plugin.settings.tasks[idx].dueDate = endDate.toISOString();
                                        this.plugin.settings.tasks[idx].updatedAt = new Date().toISOString();
                                        await this.plugin.saveSettings();
                                        if (this.plugin.settings.accessToken && task.didaId) {
                                            try { await this.plugin.updateTaskInDidaList(this.plugin.settings.tasks[idx]); } catch (e) { }
                                        }
                                        this.renderTaskList();
                                    }
                                }
                            };
                            document.addEventListener("mousemove", onMove);
                            document.addEventListener("mouseup", onUp);
                        }
                    }
                }
            });

            this.makeTaskBlockResizable(block, task, timeLabel);
        }
    }

    makeTaskBlockResizable(block: HTMLElement, task: any, timeLabel: HTMLElement) {
        const topHandle = block.createDiv("dida-time-block-resize-handle dida-time-block-resize-top");
        const bottomHandle = block.createDiv("dida-time-block-resize-handle dida-time-block-resize-bottom");
        let resizing = false;
        let activeHandle: "top" | "bottom" | null = null;
        let startY = 0;
        let startHeight = 0;
        let startTop = 0;

        const updateTimeLabel = () => {
            if (timeLabel) {
                const parentHeight = block.parentElement ? block.parentElement.offsetHeight : 0;
                if (parentHeight) {
                    const startPct = block.offsetTop / parentHeight * 100;
                    const endPct = (startPct + block.offsetHeight / parentHeight * 100) / 100 * 24 * 60;
                    const startHour = this.plugin.settings.timeBlockStartHour || 0;
                    let startMin = snapMinutes(startPct / 100 * 24 * 60 + 60 * startHour);
                    let endMin = snapMinutes(endPct + 60 * startHour);
                    if (startMin >= 1440) startMin -= 1440;
                    if (endMin >= 1440) endMin -= 1440;
                    if (startMin < 0) startMin = 0;
                    if (endMin < 0) endMin = 0;
                    const sh = Math.floor(startMin / 60).toString().padStart(2, "0");
                    const sm = (startMin % 60).toString().padStart(2, "0");
                    const eh = Math.floor(endMin / 60).toString().padStart(2, "0");
                    const em = (endMin % 60).toString().padStart(2, "0");
                    timeLabel.textContent = `${sh}:${sm} - ${eh}:${em}`;
                }
            }
        };

        const startResize = (e: MouseEvent, handle: "top" | "bottom") => {
            resizing = true;
            activeHandle = handle;
            startY = e.clientY;
            const parentHeight = block.parentElement ? block.parentElement.offsetHeight : 0;
            if (parentHeight) {
                const stepHeight = parentHeight / (1440 / TIME_GRID_STEP_MINUTES);
                startTop = Math.round(block.offsetTop / stepHeight) * stepHeight;
                const snappedBottom = Math.round((block.offsetTop + block.offsetHeight) / stepHeight) * stepHeight;
                startHeight = Math.max(stepHeight, snappedBottom - startTop);
                block.setCssStyles({
                    top: `${startTop / parentHeight * 100}%`,
                    height: `${startHeight / parentHeight * 100}%`
                });
            } else {
                startHeight = block.offsetHeight;
                startTop = block.offsetTop;
            }
            e.preventDefault();
            e.stopPropagation();
        };

        topHandle.onmousedown = (e) => startResize(e, "top");
        bottomHandle.onmousedown = (e) => startResize(e, "bottom");

        document.addEventListener("mousemove", (e) => {
            if (!resizing) return;
            const parentHeight = block.parentElement ? block.parentElement.offsetHeight : 0;
            if (!parentHeight) return;
            const diff = e.clientY - startY;
            const stepHeight = parentHeight / (1440 / TIME_GRID_STEP_MINUTES);
            if (activeHandle === "top") {
                const fixedBottom = startTop + startHeight;
                const newTop = clampMinutes(Math.round((startTop + diff) / stepHeight) * stepHeight, 0, fixedBottom - stepHeight);
                const topPct = newTop / parentHeight * 100;
                block.setCssStyles({ top: topPct + "%" });
                const newHeight = fixedBottom - newTop;
                block.setCssStyles({ height: (newHeight / parentHeight) * 100 + "%" });
                updateTimeLabel();
            } else if (activeHandle === "bottom") {
                const bottom = clampMinutes(Math.round((startTop + startHeight + diff) / stepHeight) * stepHeight, startTop + stepHeight, parentHeight);
                const newHeight = bottom - startTop;
                block.setCssStyles({ height: (newHeight / parentHeight) * 100 + "%" });
                updateTimeLabel();
            }
        });

        document.addEventListener("mouseup", async () => {
            if (!resizing) return;
            resizing = false;
            const parentHeight = block.parentElement ? block.parentElement.offsetHeight : 0;
            if (parentHeight) {
                const startPct = block.offsetTop / parentHeight * 100;
                const endPct = (startPct + block.offsetHeight / parentHeight * 100) / 100 * 24 * 60;
                const startHour = this.plugin.settings.timeBlockStartHour || 0;
                const startMin = gridStartMinutes(startPct / 100 * 24 * 60, startHour);
                const endMin = startHour * 60 + clampMinutes(snapMinutes(endPct), TIME_GRID_STEP_MINUTES, 1440);
                const idx = this.plugin.settings.tasks.findIndex(t => task.didaId ? t.didaId === task.didaId : t.id === task.id);
                if (idx !== -1) {
                    const startDate = dateAtMinutes(this.selectedDate!, startMin);
                    const endDate = dateAtMinutes(this.selectedDate!, Math.max(startMin + TIME_GRID_STEP_MINUTES, endMin));
                    this.plugin.settings.tasks[idx].startDate = startDate.toISOString();
                    this.plugin.settings.tasks[idx].dueDate = endDate.toISOString();
                    this.plugin.settings.tasks[idx].updatedAt = new Date().toISOString();
                    await this.plugin.saveSettings();
                    if (this.plugin.settings.accessToken && task.didaId) {
                        try { await this.plugin.updateTaskInDidaList(this.plugin.settings.tasks[idx]); } catch (e) { }
                    }
                    this.renderTaskList();
                }
            }
        });
    }


    async toggleTask(index: number) {
        await this.plugin.toggleTask(index);
        this.renderTaskList();
    }

    async deleteTask(index: number) {
        await this.plugin.deleteTask(index);
    }

    toggleProjectCollapse(header: HTMLElement, container: HTMLElement, projectName: string) {
        if (container.classList.contains("collapsed")) {
            container.classList.remove("collapsed");
            header.classList.remove("collapsed");
            this.plugin.settings.projectCollapsedStates[projectName] = false;
        } else {
            container.classList.add("collapsed");
            header.classList.add("collapsed");
            this.plugin.settings.projectCollapsedStates[projectName] = true;
        }
        this.plugin.saveSettings();
    }

    async reorderProjects(draggedProject: string, targetProject: string) {
        const projectMap = new Map<string, boolean>();
        this.plugin.settings.tasks.forEach(task => {
            if (!task.parentId && task.status !== 2) {
                const projectInfo = this.plugin.resolveTaskProjectInfo(task);
                const pName = projectInfo.name;
                if ((this.plugin.settings.showArchivedProjects || projectInfo.isArchived !== true) && this.plugin.isProjectVisible(projectInfo.id, projectInfo.name)) {
                    if (!projectMap.has(pName)) {
                        projectMap.set(pName, true);
                    }
                }
            }
        });

        const currentProjects = Array.from(projectMap.keys());
        let order = this.plugin.settings.projectOrder || [];

        // Ensure all current projects are in the order list
        currentProjects.forEach(p => {
            if (!order.includes(p)) order.push(p);
        });

        // Filter out projects that no longer exist
        order = order.filter(p => currentProjects.includes(p));

        const fromIndex = order.indexOf(draggedProject);
        let toIndex = order.indexOf(targetProject);

        if (fromIndex !== -1 && toIndex !== -1) {
            order.splice(fromIndex, 1);
            toIndex = order.indexOf(targetProject);
            order.splice(toIndex, 0, draggedProject);

            this.plugin.settings.projectOrder = order;
            await this.plugin.saveSettings();
            await this.renderTaskList();
        }
    }

    showAddTaskModal(projectName: string = "收集箱", projectId: string = "inbox", target: HTMLElement | null = null) {
        const projects = this.plugin.getAvailableProjectConfigs().map(project => ({ id: project.id, name: project.name }));
        new AddTaskModal(this.app, async (title, project, schedule) => {
            await this.plugin.addTask(title, project.name, project.id, true, null, schedule);
            await this.renderTaskList();
        }, {
            projects: projects.length > 0 ? projects : [{ id: projectId, name: projectName }],
            defaultProjectId: projectId,
            defaultDate: new Date(),
            triggerElement: target,
            scopeElement: this.containerEl
        }).open();
    }

    toggleTaskDetails(taskItem: HTMLElement, task: any, tab: string = "task-tab") {
        const initialTab = tab === "check-items-tab" ? "check-items-tab" : "task-tab";
        // Remove existing details
        document.querySelectorAll(".dida-task-details").forEach(el => {
            if (!taskItem.contains(el)) el.remove();
        });

        const existing = taskItem.querySelector(".dida-task-details");
        if (existing) {
            existing.remove();
            taskItem.setAttribute("draggable", "true");
            if (this.lastOpenTaskItem === taskItem) this.lastOpenTaskItem = null;
            return;
        }

        const details = taskItem.createDiv("dida-task-details");
        // 禁用当前任务项拖拽，并恢复上一个任务项的拖拽
        if (this.lastOpenTaskItem && this.lastOpenTaskItem !== taskItem && this.lastOpenTaskItem.hasAttribute("draggable")) {
            this.lastOpenTaskItem.setAttribute("draggable", "true");
        }
        taskItem.setAttribute("draggable", "false");
        this.lastOpenTaskItem = taskItem;

        const taskIndex = this.resolveTaskOriginalIndex(task);
        const currentTask = taskIndex !== -1 ? this.plugin.settings.tasks[taskIndex] : null;

        if (currentTask) {
            currentTask.content = typeof currentTask.content === "string" ? currentTask.content : (currentTask.content || "");
            currentTask.desc = typeof currentTask.desc === "string" ? currentTask.desc : (currentTask.desc || "");
            currentTask.items = currentTask.items || [];

            const nav = details.createDiv("dida-task-tab-nav");
            const taskTabBtn = nav.createEl("button", { text: "任务", cls: initialTab === "task-tab" ? "dida-tab-btn active" : "dida-tab-btn" });
            const checkTabBtn = nav.createEl("button", { text: "检查项", cls: initialTab === "check-items-tab" ? "dida-tab-btn active" : "dida-tab-btn" });

            const contentArea = details.createDiv("dida-task-content-area");

            const taskTab = contentArea.createDiv(initialTab === "task-tab" ? "dida-tab-content active" : "dida-tab-content");
            taskTab.id = "task-tab";

            const titleRow = taskTab.createDiv("dida-task-detail-title");
            titleRow.addClass("dida-detail-title-row");
            titleRow.createEl("strong", { text: "标题：" });
            const titleInput = titleRow.createEl("input", { type: "text", value: currentTask.title, cls: "dida-task-title-input" });
            titleInput.addClass("dida-detail-title-input-grow");

            const contentRow = taskTab.createDiv("dida-task-detail-content");
            let contentField = "content";
            let contentValue = currentTask.content || "";
            if (currentTask.kind === "CHECKLIST") {
                contentField = "desc";
                contentValue = currentTask.desc || "";
                contentRow.createEl("strong", { text: "描述内容：" });
            } else {
                contentRow.createEl("strong", { text: "内容：" });
            }

            const contentTextarea = contentRow.createEl("textarea", { cls: "dida-task-content-textarea" });
            contentTextarea.placeholder = "内容...";
            contentTextarea.value = contentValue;

            const checkTab = contentArea.createDiv(initialTab === "check-items-tab" ? "dida-tab-content active" : "dida-tab-content");
            checkTab.id = "check-items-tab";
            const checkList = checkTab.createDiv("dida-check-items-list");

            const renderCheckItems = () => {
                checkList.empty();
                if (currentTask.items && currentTask.items.length > 0) {
                    currentTask.items.forEach((item: any, idx: number) => {
                        const itemDiv = checkList.createDiv("dida-task-item dida-check-item");
                        const cb = itemDiv.createEl("input", { type: "checkbox" });
                        cb.checked = item.status === 1;

                        const input = itemDiv.createEl("input", {
                            type: "text",
                            value: item.title,
                            cls: item.status === 1 ? "dida-task-completed" : "dida-task-title-input",
                            placeholder: "检查项标题"
                        });

                        cb.onchange = () => {
                            item.status = cb.checked ? 1 : 0;
                            if (cb.checked) {
                                item.completedTime = new Date().toISOString();
                                input.classList.remove("dida-task-title-input");
                                input.classList.add("dida-task-completed");
                            } else {
                                item.completedTime = null;
                                input.classList.remove("dida-task-completed");
                                input.classList.add("dida-task-title-input");
                            }
                            this.updateSubtask(taskIndex, idx, item);
                        };

                        input.onchange = () => {
                            item.title = input.value;
                            this.updateSubtask(taskIndex, idx, item);
                        };

                        const delBtn = itemDiv.createEl("button", { cls: "dida-task-delete" });
                        setIconElement(delBtn, "x");
                        delBtn.onclick = (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            currentTask.items.splice(idx, 1);
                            this.updateTaskSubtasksImmediate(taskIndex, currentTask.items);
                            renderCheckItems();
                        };
                    });
                }
            };
            renderCheckItems();

            const addCheckItemBtn = checkTab.createEl("button", { cls: "dida-project-add-task-btn" });
            setIconElement(addCheckItemBtn, "plus");
            addCheckItemBtn.addClass("dida-floating-add-btn");
            addCheckItemBtn.title = "添加检查项";
            addCheckItemBtn.onclick = () => {
                if (!currentTask.items) currentTask.items = [];
                currentTask.items.push({
                    id: Date.now().toString(),
                    title: "",
                    status: 0,
                    sortOrder: currentTask.items.length
                });
                this.updateTaskSubtasks(taskIndex, currentTask.items);
                renderCheckItems();
            };

            const switchTab = (tName: string) => {
                nav.querySelectorAll(".dida-tab-btn").forEach(b => b.classList.remove("active"));
                contentArea.querySelectorAll(".dida-tab-content").forEach(c => c.classList.remove("active"));

                if (tName === "task-tab") {
                    taskTabBtn.classList.add("active");
                    taskTab.classList.add("active");
                } else {
                    checkTabBtn.classList.add("active");
                    checkTab.classList.add("active");
                }
            };

            taskTabBtn.onclick = () => switchTab("task-tab");
            checkTabBtn.onclick = () => switchTab("check-items-tab");

            const btnContainer = details.createDiv("dida-task-button-container");
            const saveBtn = btnContainer.createEl("button", { text: "保存", cls: "dida-task-save-btn mod-cta" });

            if (currentTask.didaId) {
                this.plugin.findFilesWithDidaId(currentTask.didaId).then(files => {
                    if (files.length > 0) {
                        const linkText = files.length === 1 ? "🔗 " + files[0].basename : `🔗 ${files.length}个文件`;
                        const jumpBtn = btnContainer.createEl("button", { text: linkText, cls: "dida-task-jump-btn mod-warning" });
                        jumpBtn.onclick = async () => {
                            await this.plugin.jumpToDidaIdInFile(currentTask.didaId!, jumpBtn);
                        };

                        const unlinkBtn = btnContainer.createEl("button", { cls: "dida-task-delete-link-btn", title: "删除markdown文件中的任务链接" });
                        setIconElement(unlinkBtn, "x");
                        unlinkBtn.onclick = async (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            if (confirm("确定要删除所有文件中的任务链接吗？")) {
                                await this.plugin.deleteDidaIdFromMarkdown(currentTask.didaId!);
                                details.remove();
                            }
                        };
                    }
                });
            }

            const save = async () => {
                await this.saveTaskDetails(taskIndex, titleInput.value, contentTextarea.value, contentField);
                const mainRow = taskItem.querySelector(".dida-task-main-row");
                if (mainRow) {
                    const titleEl = mainRow.querySelector(".dida-task-title, .dida-task-completed");
                    if (titleEl) this.renderTaskTitleContent(titleEl as HTMLElement, titleInput.value.trim());
                }
                details.remove();
                taskItem.setAttribute("draggable", "true");
                if (this.lastOpenTaskItem === taskItem) this.lastOpenTaskItem = null;
            };

            saveBtn.onclick = save;
            titleInput.addEventListener("keypress", (e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    save();
                }
            });
            contentTextarea.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && e.ctrlKey) {
                    e.preventDefault();
                    save();
                }
            });

            setTimeout(() => titleInput.focus(), 100);
        }
    }

    async updateTaskSchedule(index: number, date: Date | null, isAllDay: boolean, endDate?: Date, repeatFlag?: string | null) {
        const task = this.plugin.settings.tasks[index];
        if (!task) return;

        const oldDate = task.dueDate || task.startDate || null;
        if (!date) {
            task.startDate = null as any;
            task.dueDate = null as any;
            task.isAllDay = false;
            task.repeatFlag = undefined;
        } else {
            const start = new Date(date);
            const due = new Date(endDate || date);
            if (isAllDay) {
                start.setHours(0, 0, 0, 0);
                due.setHours(0, 0, 0, 0);
            } else if (due.getTime() <= start.getTime()) {
                due.setTime(start.getTime() + 15 * 60 * 1000);
            }
            task.startDate = this.plugin.formatDidaDateTime(start);
            task.dueDate = this.plugin.formatDidaDateTime(due);
            task.isAllDay = isAllDay;
            task.repeatFlag = repeatFlag || undefined;
        }

        task.updatedAt = new Date().toISOString();
        await this.plugin.saveSettings();
        if (task.didaId) {
            await this.updateNativeTaskDueDate(task, oldDate, task.dueDate || null);
        }
        await this.renderTaskList();
        if (this.plugin.settings.accessToken && task.didaId) {
            setTimeout(async () => {
                try { await this.plugin.updateTaskInDidaList(task); } catch (e) { }
            }, 0);
        }
    }

    async updateTaskStartDate(index: number, date: Date | null, isAllDay: boolean) {
        const task = this.plugin.settings.tasks[index];
        if (task) {
            const oldDate = task.startDate;
            let newDateStr: string | null = null;

            if (date) {
                if (isAllDay) {
                    const dt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
                    const y = dt.getUTCFullYear();
                    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
                    const d = String(dt.getUTCDate()).padStart(2, "0");
                    const h = String(dt.getUTCHours()).padStart(2, "0");
                    const min = String(dt.getUTCMinutes()).padStart(2, "0");
                    const s = String(dt.getUTCSeconds()).padStart(2, "0");
                    newDateStr = `${y}-${m}-${d}T${h}:${min}:${s}+0000`;
                } else {
                    const y = date.getFullYear();
                    const m = String(date.getMonth() + 1).padStart(2, "0");
                    const d = String(date.getDate()).padStart(2, "0");
                    const h = String(date.getHours()).padStart(2, "0");
                    const min = String(date.getMinutes()).padStart(2, "0");
                    const s = String(date.getSeconds()).padStart(2, "0");
                    const offset = date.getTimezoneOffset();
                    const oh = Math.abs(Math.floor(offset / 60));
                    const om = Math.abs(offset % 60);
                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                    newDateStr = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                }
            }

            const changed = task.startDate !== newDateStr;
            task.startDate = newDateStr;
            task.isAllDay = isAllDay;
            if (!isAllDay && !task.dueDate) task.dueDate = newDateStr;

            task.updatedAt = new Date().toISOString();
            await this.plugin.saveSettings();

            if (changed && task.didaId) {
                await this.updateNativeTaskDueDate(task, oldDate, task.dueDate || newDateStr || null);
            }

            this.renderTaskList();

            if (this.plugin.settings.accessToken && task.didaId) {
                setTimeout(async () => {
                    try {
                        await this.plugin.updateTaskInDidaList(task);
                    } catch (e) { }
                }, 0);
            }
        }
    }

    async updateTaskDueDate(index: number, date: Date | null, isAllDay: boolean) {
        const task = this.plugin.settings.tasks[index];
        if (task) {
            const oldDate = task.dueDate;
            let newDateStr: string | null = null;
            if (date) {
                if (isAllDay) {
                    const y = date.getFullYear();
                    const m = String(date.getMonth() + 1).padStart(2, "0");
                    const d = String(date.getDate()).padStart(2, "0");
                    const h = String(date.getHours()).padStart(2, "0");
                    const min = String(date.getMinutes()).padStart(2, "0");
                    const s = String(date.getSeconds()).padStart(2, "0");
                    const offset = date.getTimezoneOffset();
                    const oh = Math.abs(Math.floor(offset / 60));
                    const om = Math.abs(offset % 60);
                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                    newDateStr = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                } else {
                    const y = date.getFullYear();
                    const m = String(date.getMonth() + 1).padStart(2, "0");
                    const d = String(date.getDate()).padStart(2, "0");
                    const h = String(date.getHours()).padStart(2, "0");
                    const min = String(date.getMinutes()).padStart(2, "0");
                    const s = String(date.getSeconds()).padStart(2, "0");
                    const offset = date.getTimezoneOffset();
                    const oh = Math.abs(Math.floor(offset / 60));
                    const om = Math.abs(offset % 60);
                    const tz = (offset <= 0 ? "+" : "-") + String(oh).padStart(2, "0") + String(om).padStart(2, "0");
                    newDateStr = `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
                }
            }

            task.dueDate = newDateStr;
            task.isAllDay = isAllDay;
            task.updatedAt = new Date().toISOString();
            await this.plugin.saveSettings();

            if (task.didaId) {
                await this.updateNativeTaskDueDate(task, oldDate, newDateStr);
            }

            this.renderTaskList();
            if (this.plugin.settings.accessToken && task.didaId) {
                setTimeout(async () => {
                    try {
                        await this.plugin.updateTaskInDidaList(task);
                    } catch (e) { }
                }, 0);
            }
        }
    }

    formatPriorityLabel(priority: number): string {
        if (priority === 5) return "🔴";
        if (priority === 3) return "🟡";
        if (priority === 1) return "🔵";
        return "⚪";
    }

    async cycleTaskPriority(index: number) {
        const task = this.plugin.settings.tasks[index];
        if (!task) return;
        const current = task.priority || 0;
        task.priority = current === 0 ? 1 : current === 1 ? 3 : current === 3 ? 5 : 0;
        task.updatedAt = new Date().toISOString();
        await this.plugin.saveSettings();
        if (task.didaId) {
            await this.updateNativeTaskDueDate(task, task.dueDate, task.dueDate);
        }
        this.renderTaskList();
        if (this.plugin.settings.accessToken && task.didaId) {
            setTimeout(async () => {
                try {
                    await this.plugin.updateTaskInDidaList(task);
                } catch (e) { }
            }, 0);
        }
    }

    async saveTaskDetails(index: number, title: string, content: string, contentField: string = "content") {
        const task = this.plugin.settings.tasks[index];
        if (task) {
            const trimmed = title.trim();
            if (trimmed) {
                const titleChanged = task.title !== trimmed;
                const oldTitle = task.title;
                task.title = trimmed;
                if (task.items && task.items.length > 0) {
                    task.content = content;
                    task.desc = content;
                } else if (contentField === "desc") {
                    task.desc = content;
                } else {
                    task.content = content;
                }
                task.updatedAt = new Date().toISOString();
                await this.plugin.saveSettings();
                if (titleChanged && task.didaId) {
                    await this.updateNativeTaskTitle(task, oldTitle, trimmed);
                }
                if (task.didaId) {
                    this.plugin.syncTaskToDidaListInBackground(task);
                }
            } else {
                new Notice("任务标题不能为空");
            }
        }
    }

    async updateNativeTaskDueDate(task: DidaTask, oldDueDate: string | null | undefined, newDueDate: string | null | undefined) {
        try {
            this.plugin._isUpdatingNativeTaskStatus = true;
            for (const file of this.app.vault.getMarkdownFiles()) {
                try {
                    const lines = (await this.app.vault.read(file)).split("\n");
                    let updated = false;
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const parsed = parseTaskLine(line);
                        if (parsed && parsed.didaId === task.didaId) {
                            lines[i] = formatTaskLine(line, {
                                startDate: task.startDate || null,
                                dueDate: newDueDate || null,
                                isAllDay: task.isAllDay,
                                priority: task.priority || 0,
                                repeatFlag: task.repeatFlag || null
                            });
                            updated = updated || lines[i] !== line;
                            continue;
                        }
                        if (line.includes(`[🔗Dida](obsidian://dida-task?didaId=${task.didaId})`)) {
                            lines[i] = formatTaskLine(line, {
                                startDate: task.startDate || null,
                                dueDate: newDueDate || null,
                                isAllDay: task.isAllDay,
                                priority: task.priority || 0,
                                repeatFlag: task.repeatFlag || null
                            });
                            updated = lines[i] !== line;
                        }
                    }
                    if (updated) {
                        await this.app.vault.modify(file, lines.join("\n"));
                    }
                } catch (e) { }
            }
        } catch (e) { }
        finally {
            this.plugin._isUpdatingNativeTaskStatus = false;
        }
    }

    convertDidaDateToNativeFormat(date: string | null) {
        if (!date) return null;
        try {
            const d = new Date(date);
            return d.getFullYear() + `-${String(d.getMonth() + 1).padStart(2, "0")}-` + String(d.getDate()).padStart(2, "0");
        } catch (e) {
            return null;
        }
    }

    async updateNativeTaskTitle(task: DidaTask, oldTitle: string, newTitle: string) {
        try {
            this.plugin._isUpdatingNativeTaskStatus = true;
            for (const file of this.app.vault.getMarkdownFiles()) {
                try {
                    const lines = (await this.app.vault.read(file)).split("\n");
                    let updated = false;
                    for (let i = 0; i < lines.length; i++) {
                        let line = lines[i];
                        const parsed = parseTaskLine(line);
                        if (parsed && parsed.didaId === task.didaId) {
                            lines[i] = formatTaskLine(line, { title: newTitle });
                            updated = updated || lines[i] !== line;
                            continue;
                        }
                        if (line.includes(`[🔗Dida](obsidian://dida-task?didaId=${task.didaId})`)) {
                            const prefixMatch = line.match(/^(\s*-\s*\[[ x]\]\s*)/);
                            const linkMatch = line.match(/\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[a-zA-Z0-9]+\)/);
                            const dateMatch = line.match(/📅\s*\d{4}-\d{2}-\d{2}/);
                            if (prefixMatch) {
                                const textOnly = line.replace(/^\s*-\s*\[[ x]\]\s*/, "").replace(/\s*\[🔗Dida\]\(obsidian:\/\/dida-task\?didaId=[a-zA-Z0-9]+\)\s*/g, "").replace(/\s*\[[0-9]{1,2}:[0-9]{2}\s*-\s*[0-9]{1,2}:[0-9]{2}\]\s*/g, "").replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*/g, "").replace(/\s*🔁\s*every[^📅🔴🟡🔵⚪]*/g, "").replace(/[🔴🟡🔵⚪]/g, "").trim();
                                if (textOnly === oldTitle.trim()) {
                                    lines[i] = formatTaskLine(line, { title: newTitle });
                                    updated = true;
                                }
                            }
                        }
                    }
                    if (updated) {
                        await this.app.vault.modify(file, lines.join("\n"));
                    }
                } catch (e) { }
            }
        } catch (e) { }
        finally {
            this.plugin._isUpdatingNativeTaskStatus = false;
        }
    }

    async updateNativeTaskStatus(task: DidaTask, completed: boolean) {
        try {
            this.plugin._isUpdatingNativeTaskStatus = true;
            for (const file of this.app.vault.getMarkdownFiles()) {
                try {
                    const lines = (await this.app.vault.read(file)).split("\n");
                    let updated = false;
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const parsed = parseTaskLine(line);
                        if (parsed && parsed.didaId === task.didaId) {
                            lines[i] = formatTaskLine(line, { checkbox: completed ? "x" : " " });
                            updated = updated || lines[i] !== line;
                            continue;
                        }
                        if (line.includes(`[🔗Dida](obsidian://dida-task?didaId=${task.didaId})`)) {
                            const indentMatch = line.match(/^(\s*)/);
                            const taskMatch = line.match(/^(\s*)-\s*\[[ x]\]\s*(.*)/);
                            if (taskMatch) {
                                const indent = indentMatch ? indentMatch[1] : "";
                                const rest = taskMatch[2];
                                const newLine = completed ? `${indent}- [x] ${rest}` : `${indent}- [ ] ${rest}`;
                                lines[i] = newLine;
                                updated = true;
                            }
                        }
                    }
                    if (updated) {
                        await this.app.vault.modify(file, lines.join("\n"));
                    }
                } catch (e) { }
            }
        } catch (e) { }
        finally {
            this.plugin._isUpdatingNativeTaskStatus = false;
        }
    }

    async updateSubtask(taskIndex: number, itemIndex: number, item: any) {
        const task = this.plugin.settings.tasks[taskIndex];
        if (task && task.items) {
            task.items[itemIndex] = item;
            if (task.items.length > 0) {
                if (task.content && !task.desc) task.desc = task.content;
                else if (task.desc && !task.content) task.content = task.desc;
            }
            task.updatedAt = new Date().toISOString();
            await this.plugin.saveSettings();
            setTimeout(() => {
                this.syncTaskToDidaListInBackground(task);
            }, 0);
        }
    }

    async updateTaskSubtasks(taskIndex: number, items: any[]) {
        const task = this.plugin.settings.tasks[taskIndex];
        if (task) {
            task.items = items;
            if (items && items.length > 0) {
                if (task.content && !task.desc) task.desc = task.content;
                else if (task.desc && !task.content) task.content = task.desc;
            }
            task.updatedAt = new Date().toISOString();
            await this.plugin.saveSettings();
            setTimeout(() => {
                this.syncTaskToDidaListInBackground(task);
            }, 0);
        }
    }

    async updateTaskSubtasksImmediate(taskIndex: number, items: any[]) {
        const task = this.plugin.settings.tasks[taskIndex];
        if (task) {
            task.items = items;
            if (items && items.length > 0) {
                if (task.content && !task.desc) task.desc = task.content;
                else if (task.desc && !task.content) task.content = task.desc;
            }
            task.updatedAt = new Date().toISOString();
            await this.plugin.saveSettings();
            await this.syncTaskToDidaListInBackground(task);
        }
    }

    async syncTaskToDidaListInBackground(task: DidaTask) {
        if (this.plugin.settings.accessToken && task.didaId) {
            try {
                await this.plugin.updateTaskInDidaList(task);
            } catch (e) { }
        }
    }

    updateTaskRowSubtaskCount(taskItem: HTMLElement, task: any) {
        const existing = taskItem.querySelector(".dida-subtask-count") as HTMLSpanElement | null;
        if (task.items && task.items.length > 0) {
            const completedItems = task.items.filter((i: any) => i.status === 1).length;
            const span = existing || document.createElement("span");
            span.className = "dida-subtask-count";
            setTextWithIcon(span, `${completedItems}/${task.items.length}`, "list-todo");
            span.addClass("dida-task-count-base", "dida-task-count-sub");
            span.title = "点击查看检查项";
            span.onclick = () => this.toggleTaskDetails(taskItem, task, "check-items-tab");
            if (!existing) taskItem.querySelector(".dida-task-left-content")?.appendChild(span);
        } else if (existing) {
            existing.remove();
        }
    }

    updateTaskRowChildCount(taskItem: HTMLElement, task: any) {
        const existing = taskItem.querySelector(".dida-child-task-count") as HTMLSpanElement | null;
        const childTasks = this.getTaskChildTasks(task);
        if (childTasks.length > 0) {
            const completedChilds = childTasks.filter(t => t.status === 2).length;
            const span = existing || document.createElement("span");
            span.className = "dida-child-task-count";
            span.addClass("dida-task-count-base", "dida-task-count-child");
            const collapsed = resolveDidaTaskCollapsedState(task, childTasks.length, this.plugin.settings.childTaskCollapsedStates);
            this.renderChildCountControl(span, completedChilds, childTasks.length, collapsed, true);
            span.title = collapsed ? "点击展开子任务" : "点击收起子任务";
            span.onclick = async (event) => {
                event.stopPropagation();
                await this.toggleTaskChildrenCollapsed(task);
            };
            span.setAttribute("aria-expanded", collapsed ? "false" : "true");
            if (!existing) taskItem.querySelector(".dida-task-left-content")?.appendChild(span);
        } else if (existing) {
            existing.remove();
        }
    }

    updateTaskRowRepeatRule(taskItem: HTMLElement | any, task?: any) {
        const targetTask = task || taskItem;
        let targetItem: HTMLElement | null = null;
        if (taskItem instanceof HTMLElement) targetItem = taskItem;
        else if (targetTask?.id) {
            const el = this.containerEl.querySelector(`[data-task-id="${targetTask.id}"]`);
            targetItem = el ? el.closest(".dida-task-item") as HTMLElement : null;
        }
        if (!targetItem) return;
        const existing = targetItem.querySelector(".dida-task-repeat-rule");
        if (targetTask.repeatFlag && targetTask.repeatFlag.trim() !== "") {
            const repeatRule = translateRepeatFlag(targetTask.repeatFlag);
            if (repeatRule) {
                if (existing) {
                    setTextWithIcon(existing as HTMLElement, repeatRule.label, repeatRule.icon, { textFirst: true });
                } else {
                    const div = document.createElement("div");
                    div.className = "dida-task-repeat-rule";
                    setTextWithIcon(div, repeatRule.label, repeatRule.icon, { textFirst: true });
                    targetItem.appendChild(div);
                }
            }
        } else if (existing) {
            existing.remove();
        }
    }

    // ==================== Drag Task to Markdown ====================

    _enableTaskDragToMarkdown(element: HTMLElement, task: DidaTask) {
        if (!element || !task) return;
        if (!task.didaId) return;
        if (element.dataset && element.dataset.didaDragBound === "1") return;
        element.setAttribute("draggable", "true");
        if (element.dataset) element.dataset.didaDragBound = "1";
        element.addEventListener("dragstart", (e: DragEvent) => {
            this._beginSidebarTaskDragMenuSuppression();
            try {
                const payload = this._buildDidaTaskDragPayload(task);
                if (payload && e.dataTransfer) {
                    e.dataTransfer.setData("text/plain", payload);
                    e.dataTransfer.effectAllowed = "copyMove";
                    element.classList.add("dida-task-dragging");
                    e.stopPropagation();
                }
            } catch (err) { }
        });
        element.addEventListener("dragend", () => {
            element.classList.remove("dida-task-dragging");
            this._scheduleEndSidebarTaskDragMenuSuppression();
            setTimeout(() => {
                this._collapseActiveMarkdownEditorSelectionAfterSidebarTaskDrop();
            }, 0);
        });
    }

    _buildDidaTaskDragPayload(task: DidaTask): string {
        if (!task || !task.didaId) return "";
        return buildDidaTaskDragPayload(task, this.plugin.settings.tasks || []);
    }

    _formatDidaTaskLineForDrag(task: DidaTask, indent: string): string {
        if (!task || !task.didaId) return "";
        return formatTaskLineFromTask(task, indent);
    }

    _formatDidaTaskDueDateForDrag(task: DidaTask): string {
        const dateValue = (task && (task.dueDate || task.startDate)) || null;
        if (!dateValue) return "";
        try {
            const date = new Date(dateValue);
            if (isNaN(date.getTime())) return "";
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, "0");
            const d = String(date.getDate()).padStart(2, "0");
            return ` 📅 ${y}-${m}-${d}`;
        } catch {
            return "";
        }
    }

    _beginSidebarTaskDragMenuSuppression() {
        // Suppress context menu during drag
    }

    _scheduleEndSidebarTaskDragMenuSuppression() {
        // Restore context menu after drag
    }

    _collapseActiveMarkdownEditorSelectionAfterSidebarTaskDrop() {
        try {
            const leaves = this.plugin.app.workspace.getLeavesOfType("markdown");
            for (const leaf of leaves) {
                const view = leaf.view;
                if (view && (view as any).editor) {
                    const editor = (view as any).editor as any;
                    if (editor && editor.cm && editor.cm.doc) {
                        const sel = editor.cm.doc.selection;
                        if (!sel.empty()) {
                            editor.cm.dispatch({
                                selection: { anchor: sel.anchor },
                                scrollIntoView: true
                            });
                        }
                    }
                }
            }
        } catch { }
    }

}
