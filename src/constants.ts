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
    projectCollapsedStates: {},
    projectOrder: [],
    defaultViewMode: "task",
    timeBlockHourHeight: 80,
    timeBlockStartHour: 0
};

export const OAUTH_CONFIG = {
    authUrl: "https://dida365.com/oauth/authorize",
    tokenUrl: "https://dida365.com/oauth/token",
    scope: "tasks:write tasks:read"
};

export const TASK_VIEW_TYPE = "dida-task-view";
export const TIME_BLOCK_VIEW_TYPE = "dida-time-block-view";
