export const DEFAULT_SETTINGS = {
    clientId: "",
    clientSecret: "",
    accessToken: "",
    refreshToken: "",
    autoSync: true,
    syncInterval: 5,
    serverPort: 8080,
    showArchivedProjects: false,
    tasks: [],
    autoCleanCompletedTasks: false,
    autoCleanInterval: 1,
    enableNativeTaskSync: true,
    nativeTaskAutoSyncTags: "",
    nativeTaskAutoSyncMarkers: "",
    nativeTaskRemarkFormat: "--- ${remark}",
    taskNoteSyncTargetBlockHeader: "> [!todo]",
    taskNoteSyncFolder: "DidaSync",
    taskNoteSyncPathPatterns: {
        day: "",
        week: "",
        month: "",
        year: ""
    },
    taskNoteSyncCreateNewFile: false,
    taskNoteSyncWeekStart: "monday",
    taskNoteSyncUseRemoteQuery: true,
    projectCollapsedStates: {},
    projectOrder: [],
    projectIcons: {},
    projectCatalog: [],
    defaultViewMode: "task",
    defaultCalendarMode: "day",
    defaultShowCompletedInCalendar: false,
    showTimelineEntry: true,
    showPomodoroEntry: true,
    timeBlockHourHeight: 80,
    timeBlockStartHour: 0,
    pomodoroSettings: {
        focusMinutes: 25,
        shortBreakMinutes: 5,
        longBreakMinutes: 15,
        focusPresetMinutes: [15, 25, 40, 60],
        longBreakPresetMinutes: [15, 20, 25, 30],
        completionHistory: {},
        selectedSound: "none",
        totalFocusSessions: 0,
        totalFocusMinutes: 0
    }
};

export const OAUTH_CONFIG = {
    authUrl: "https://dida365.com/oauth/authorize",
    tokenUrl: "https://dida365.com/oauth/token",
    scope: "tasks:write tasks:read"
};

export const TASK_VIEW_TYPE = "dida-task-view";
export const TIME_BLOCK_VIEW_TYPE = "dida-time-block-view";
