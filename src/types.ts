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
    desc?: string;
    isAllDay?: boolean;
    startDate?: string; // ISO String
    dueDate?: string; // ISO String
    timeZone?: string;
    reminders?: any[];
    repeatFlag?: string; // RRULE string
    priority?: number;
    status: number; // 0: Normal, 2: Completed
    completedTime?: string | null;
    projectId: string; // "inbox" or specific project ID
    projectName?: string; // Enriched field for display
    sortOrder?: number;
    items?: DidaSubTask[];
    kind?: "TEXT" | "CHECKLIST";

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
    etag?: string;

    // Native Sync fields
    hasLink?: boolean; // If linked to a markdown file
    linkPath?: string;
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

export interface DidaSyncSettings {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;

    tasks: DidaTask[];
    projects: DidaProject[]; // Cache of projects

    autoSync: boolean;
    syncInterval: number; // in minutes
    serverPort: number;
    showArchivedProjects: boolean;

    autoCleanCompletedTasks: boolean;
    autoCleanInterval: number; // in months

    enableNativeTaskSync: boolean;

    // Daily Sync Settings
    dailySyncTargetBlockHeader: string;

    // UI Settings
    projectCollapsedStates: { [key: string]: boolean };
    projectOrder: string[]; // Array of project names/ids to store order
    defaultViewMode: "task" | "timeblock";
    timeBlockHourHeight: number;
    timeBlockStartHour: number;
}

export const DEFAULT_SETTINGS: DidaSyncSettings = {
    clientId: "",
    clientSecret: "",
    accessToken: "",
    refreshToken: "",
    tasks: [],
    projects: [],
    autoSync: true,
    syncInterval: 5,
    serverPort: 8080,
    showArchivedProjects: false,
    autoCleanCompletedTasks: false,
    autoCleanInterval: 1,
    enableNativeTaskSync: true,
    dailySyncTargetBlockHeader: "> [!todo]",
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
