export interface DidaSubTask {
    id: string;
    title: string;
    status: number; // 0: Normal, 1: Completed (Checklist items use 1 for completed)
    sortOrder?: number;
    startDate?: string;
    isAllDay?: boolean;
    timeZone?: string;
    completedTime?: string | number; // API returns string or number
}

export interface DidaTask {
    id: string;
    title: string;
    content: string;
    completed?: boolean;
    isFloating?: boolean;
    desc?: string;
    isAllDay?: boolean;
    startDate?: string; // ISO String
    dueDate?: string; // ISO String
    timeZone?: string;
    reminders?: any[];
    repeatFlag?: string; // RRULE string
    priority?: number;
    tags?: string[];
    status: number; // 0: Normal, 2: Completed
    completedTime?: string | null;
    projectId: string; // "inbox" or specific project ID
    projectName?: string; // Enriched field for display
    sortOrder?: number;
    items?: DidaSubTask[];
    kind?: "TEXT" | "NOTE" | "CHECKLIST";

    // Project related fields (enriched during sync)
    projectColor?: string;
    projectClosed?: boolean;
    projectViewMode?: string;
    projectKind?: string;
    projectPermission?: string;

    // Local fields
    didaId?: string; // usually same as id
    parentId?: string | null; // For subtasks/items if flattened
    createdAt?: string;
    updatedAt?: string;
    modifiedTime?: string;
    etag?: string;

    // Native Sync fields
    hasLink?: boolean; // If linked to a markdown file
    linkPath?: string;
    remoteDeleted?: boolean;

    // Placement sync UI state
    syncPlacementPending?: boolean;
    syncPlacementError?: string;
}

export type DidaNoteSyncStatus = "synced" | "conflict" | "error" | "missing";
export type DidaNoteSyncRunSource = "manual" | "auto" | "recovery";
export type DidaNoteSyncRunStatus = "success" | "partial" | "failed" | "skipped";

export interface DidaNoteSyncRecord {
    didaId: string;
    title: string;
    path: string;
    projectId?: string;
    projectName?: string;
    etag?: string | null;
    remoteModifiedTime?: string | null;
    lastSyncedContentHash: string;
    lastSyncedAt: string;
    status: DidaNoteSyncStatus;
    remoteMissing?: boolean;
    error?: string;
}

export interface DidaNoteSyncSummary {
    outcome: DidaNoteSyncRunStatus;
    fetched: number;
    synced: number;
    pushed: number;
    conflicts: number;
    skipped: number;
    missing: number;
    errors: string[];
    summaryText: string;
}

export interface DidaNoteSyncRunState extends DidaNoteSyncSummary {
    source: DidaNoteSyncRunSource;
    startedAt: string;
    finishedAt: string;
}

export interface CompletedTasksQuery {
    projectIds?: string[];
    startDate?: string;
    endDate?: string;
}

export interface CompletedTaskCacheSegment {
    projectIds?: string[];
    startDate: string;
    endDate: string;
    fetchedAt: string;
    complete: boolean;
}

export interface DidaProject {
    id: string;
    name: string;
    color?: string;
    sortOrder?: number;
    closed?: boolean;
    groupId?: string;
    viewMode?: string;
    permission?: string;
    kind?: string;
}

export interface ProjectCatalogEntry {
    id: string;
    name: string;
    isArchived: boolean;
    isLocalOnly: boolean;
    kind?: string;
    viewMode?: string;
}

export interface PomodoroSettings {
    focusMinutes: number;
    shortBreakMinutes: number;
    longBreakMinutes: number;
    focusPresetMinutes: number[];
    longBreakPresetMinutes: number[];
    completionHistory: Record<string, { sessions: number; minutes: number }>;
    selectedSound: string;
    totalFocusSessions: number;
    totalFocusMinutes: number;
}

export interface TaskNoteSyncPathPatterns {
    day: string;
    week: string;
    month: string;
    year: string;
}

export interface TaskScheduleInput {
    startDate?: string | null;
    dueDate?: string | null;
    isAllDay: boolean;
    repeatFlag?: string | null;
}

export interface PendingPlacementOperationPayload {
    fromProjectId: string;
    fromProjectName?: string;
    fromParentId?: string | null;
    toProjectId: string;
    toProjectName?: string;
    toParentId?: string | null;
    parentTaskId?: string;
    parentDidaId?: string;
}

export type PendingSyncOperationType = "upsert" | "complete" | "delete" | "placement";

export interface PendingSyncOperation {
    localTaskId: string;
    didaId?: string;
    projectId?: string;
    type: PendingSyncOperationType;
    payload?: Partial<DidaTask> | PendingPlacementOperationPayload;
    createdAt: string;
    modifiedAt?: string;
    attempts: number;
    lastError?: string;
    requestStartedAt?: string;
    state?: "pending" | "uncertain" | "permanent_failure";
    nextRetryAt?: string;
    fingerprint?: string;
}

export type SyncRunSource = "manual" | "auto" | "recovery";
export type SyncRunScope = "all" | "tasks" | "notes";
export type SyncEntityKind = "task" | "note" | "projection" | "deletion";

export interface SyncRunRequest {
    source: SyncRunSource;
    scope: SyncRunScope;
    silent?: boolean;
}

export interface SyncScopeResult {
    key: string;
    entityKind: SyncEntityKind;
    outcome: "success" | "partial" | "failed" | "skipped";
    pulled: number;
    pushed: number;
    failures: SyncFailureDetail[];
}

export interface SyncDeletionCandidate {
    id: string;
    entityKind: "task" | "note";
    remoteId: string;
    localId?: string;
    path?: string;
    projectId?: string;
    title: string;
    reason: "local_file_missing" | "local_task_line_missing";
    detectedAt: string;
    promptedAt?: string;
}

export interface SyncProjectionOperation {
    id: string;
    entityKind: "task" | "note";
    remoteId: string;
    path?: string;
    operation: "update" | "detach";
    payload?: Record<string, unknown>;
    createdAt: string;
    attempts: number;
    lastError?: string;
}

export interface NativeTaskLinkRecord {
    remoteId: string;
    path: string;
    title: string;
    lastSeenAt: string;
}

export interface SyncResult {
    outcome: "success" | "partial" | "failed" | "skipped";
    uploaded: number;
    downloaded: number;
    failedScopes: string[];
    failedOperations: string[];
    failedDetails?: SyncFailureDetail[];
    cleanupPerformed: boolean;
    scopeResults?: SyncScopeResult[];
    noteSummary?: DidaNoteSyncSummary;
}

export type SyncPhase = "idle" | "queued" | "scanning" | "fetching" | "planning" | "uploading" | "downloading" | "reconciling" | "projecting" | "verifying" | "completed" | "failed";

export interface SyncRunState {
    phase: SyncPhase;
    isRunning: boolean;
    queued: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    message: string;
}

export interface SyncFailureDetail {
    localTaskId?: string;
    didaId?: string;
    title?: string;
    projectName?: string;
    operation?: PendingSyncOperationType | string;
    reason: string;
    attempts?: number;
}

export type OAuthCallbackMode = "localhost" | "ipv4";
export type DidaServiceRegion = "dida365" | "ticktick";

export interface DidaServiceConfig {
    label: string;
    developerUrl: string;
    authUrl: string;
    tokenUrl: string;
    apiBaseUrl: string;
    scope: string;
}

export const DIDA_SERVICE_CONFIGS: Record<DidaServiceRegion, DidaServiceConfig> = {
    dida365: {
        label: "滴答清单（中国区）",
        developerUrl: "https://developer.dida365.com/manage",
        authUrl: "https://dida365.com/oauth/authorize",
        tokenUrl: "https://dida365.com/oauth/token",
        apiBaseUrl: "https://api.dida365.com/open/v1",
        scope: "tasks:write tasks:read"
    },
    ticktick: {
        label: "TickTick（国际版）",
        developerUrl: "https://developer.ticktick.com/manage",
        authUrl: "https://ticktick.com/oauth/authorize",
        tokenUrl: "https://ticktick.com/oauth/token",
        apiBaseUrl: "https://api.ticktick.com/open/v1",
        scope: "tasks:write tasks:read"
    }
};

export interface DidaSyncSettings {
    serviceRegion: DidaServiceRegion;
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
    remoteInboxProjectId?: string;

    tasks: DidaTask[];
    projects: DidaProject[]; // Cache of projects

    projectCatalog: ProjectCatalogEntry[];
    projectIcons: { [key: string]: string };
    hiddenProjectKeys: string[];

    autoSync: boolean;
    syncInterval: number; // in minutes
    serverPort: number;
    oauthCallbackMode: OAuthCallbackMode;
    userTimeZone: string;
    enableMcpServer: boolean;
    mcpPort: number;
    mcpToken: string;
    mcpReadOnly: boolean;
    mcpSkillNotePath: string;
    showArchivedProjects: boolean;

    autoCleanCompletedTasks: boolean;
    autoCleanInterval: number; // in months

    enableNativeTaskSync: boolean;

    // Task note sync settings
    taskNoteSyncTargetBlockHeader: string;
    taskNoteSyncFolder: string;
    taskNoteSyncPathPatterns: TaskNoteSyncPathPatterns;
    taskNoteSyncCreateNewFile: boolean;
    taskNoteSyncWeekStart: "monday" | "sunday";
    taskNoteSyncUseRemoteQuery: boolean;
    taskNoteSyncProjectScope: "all" | "visible" | "custom";
    taskNoteSyncProjectKeys: string[];

    // Dida NOTE sync settings
    enableDidaNoteSync: boolean;
    didaNoteSyncFolder: string;
    didaNoteSyncProjectIds: string[];
    didaNoteSyncRecords: DidaNoteSyncRecord[];
    didaNoteSyncLastRun: DidaNoteSyncRunState | null;

    // UI Settings
    projectCollapsedStates: { [key: string]: boolean };
    childTaskCollapsedStates: { [key: string]: boolean };
    projectOrder: string[]; // Array of project names/ids to store order
    defaultViewMode: "task" | "timeblock";
    defaultCalendarMode?: "day" | "week" | "month" | "year";
    defaultShowCompletedInCalendar?: boolean;
    showTimelineEntry?: boolean;
    showPomodoroEntry?: boolean;
    timeBlockHourHeight: number;
    timeBlockStartHour: number;

    // Pomodoro settings
    pomodoroSettings: PomodoroSettings;

    // Reverse completion verification metadata
    reverseCompletionMeta: {
        [didaId: string]: {
            missingStreak: number;
            lastSeenAt: string | null;
            lastMissingAt: string | null;
        }
    };

    // Sync consistency metadata
    syncConsistencyMeta: {
        [didaId: string]: {
            title?: string;
            date?: string;
        }
    };

    completedTasks: DidaTask[];
    completedTasksLastFetchedAt: string;
    completedTasksQuery: CompletedTasksQuery;
    completedTaskCacheSegments: CompletedTaskCacheSegment[];
    pendingSyncOperations: PendingSyncOperation[];
    pendingSyncProjections: SyncProjectionOperation[];
    syncDeletionCandidates: SyncDeletionCandidate[];
    detachedSyncEntities: string[];
    nativeTaskLinkIndex: Record<string, NativeTaskLinkRecord>;
}

export const DEFAULT_SETTINGS: DidaSyncSettings = {
    serviceRegion: "dida365",
    clientId: "",
    clientSecret: "",
    accessToken: "",
    refreshToken: "",
    remoteInboxProjectId: "",
    tasks: [],
    projects: [],
    projectCatalog: [],
    projectIcons: {},
    hiddenProjectKeys: [],
    autoSync: true,
    syncInterval: 5,
    serverPort: 8080,
    oauthCallbackMode: "localhost",
    userTimeZone: "",
    enableMcpServer: false,
    mcpPort: 35829,
    mcpToken: "",
    mcpReadOnly: false,
    mcpSkillNotePath: "dida/SKILL.md",
    showArchivedProjects: false,
    autoCleanCompletedTasks: false,
    autoCleanInterval: 1,
    enableNativeTaskSync: true,
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
    taskNoteSyncProjectScope: "all",
    taskNoteSyncProjectKeys: [],
    enableDidaNoteSync: false,
    didaNoteSyncFolder: "DidaNotes",
    didaNoteSyncProjectIds: [],
    didaNoteSyncRecords: [],
    didaNoteSyncLastRun: null,
    projectCollapsedStates: {},
    childTaskCollapsedStates: {},
    projectOrder: [],
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
    },
    reverseCompletionMeta: {},
    syncConsistencyMeta: {},
    completedTasks: [],
    completedTasksLastFetchedAt: "",
    completedTasksQuery: {},
    completedTaskCacheSegments: [],
    pendingSyncOperations: [],
    pendingSyncProjections: [],
    syncDeletionCandidates: [],
    detachedSyncEntities: [],
    nativeTaskLinkIndex: {}
};
