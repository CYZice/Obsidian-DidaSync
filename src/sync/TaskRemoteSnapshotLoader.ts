export interface ProjectTaskSnapshot {
    tasks: any[];
    successfulProjectIds: string[];
    failures: string[];
}

export interface InboxTaskSnapshot {
    tasks: any[];
    succeeded: boolean;
    failure?: string;
}

interface TaskRemoteSnapshotLoaderHost {
    apiClient: {
        buildApiUrl(path: string): string;
        makeAuthenticatedRequest(url: string): Promise<any>;
    };
}

export class TaskRemoteSnapshotLoader {
    constructor(private host: TaskRemoteSnapshotLoaderHost) { }

    async fetchProjects(
        projects: any[],
        projectMap: Map<string, any>,
        normalizeProjectId: (projectId: string) => string
    ): Promise<ProjectTaskSnapshot> {
        const tasks: any[] = [];
        const successfulProjectIds: string[] = [];
        const failures: string[] = [];
        let cursor = 0;
        const workers = Array.from({ length: Math.min(4, projects.length) }, async () => {
            while (cursor < projects.length) {
                const project = projects[cursor++];
                const projectId = normalizeProjectId(project.id);
                const fetched = await this.fetchFirstValid([
                    `/project/${project.id}/task`,
                    `/project/${project.id}/data`,
                    `/task?projectId=${project.id}`
                ]);
                if (!fetched.succeeded) {
                    failures.push(`project:${project.id}：${fetched.failure}`);
                    continue;
                }
                const display = projectMap.get(projectId);
                for (const task of fetched.tasks) {
                    task.projectId = projectId;
                    task.projectName = projectId === "inbox" ? "收集箱" : project.name;
                    task.projectColor = display?.color;
                    task.projectClosed = display?.closed;
                    task.projectViewMode = display?.viewMode;
                    task.projectKind = display?.kind;
                    task.projectPermission = display?.permission;
                    tasks.push(task);
                }
                successfulProjectIds.push(projectId);
            }
        });
        await Promise.all(workers);
        return { tasks, successfulProjectIds, failures };
    }

    async fetchInbox(
        remoteInboxProjectId: string,
        project: any,
        normalizeProjectId: (projectId: string) => string,
        isInboxProjectId: (projectId: string | undefined) => boolean
    ): Promise<InboxTaskSnapshot> {
        const fetched = await this.fetchFirstValid([
            `/project/${remoteInboxProjectId}/task`,
            `/project/${remoteInboxProjectId}/data`,
            `/task?projectId=${remoteInboxProjectId}`,
            "/task"
        ], isInboxProjectId);
        if (!fetched.succeeded) return { tasks: [], succeeded: false, failure: `inbox：${fetched.failure}` };
        for (const task of fetched.tasks) {
            task.projectId = normalizeProjectId(task.projectId);
            task.projectName = "收集箱";
            task.projectColor = project?.color;
            task.projectClosed = project?.closed;
            task.projectViewMode = project?.viewMode;
            task.projectKind = project?.kind;
            task.projectPermission = project?.permission;
        }
        return { tasks: fetched.tasks, succeeded: true };
    }

    private async fetchFirstValid(paths: string[], filterTask?: (projectId: string | undefined) => boolean) {
        let failure = "未能获取任务数据";
        for (const path of paths) {
            try {
                const response = await this.host.apiClient.makeAuthenticatedRequest(this.host.apiClient.buildApiUrl(path));
                if (!response.ok) {
                    failure = `HTTP ${response.status}`;
                    continue;
                }
                const payload = await response.json();
                let tasks: any[] | null = null;
                if (Array.isArray(payload)) tasks = payload;
                else if (Array.isArray(payload?.tasks)) tasks = payload.tasks;
                else if (Array.isArray(payload?.data)) tasks = payload.data;
                if (!tasks) {
                    failure = `响应格式无效（HTTP ${response.status}）`;
                    continue;
                }
                if (path === "/task" && filterTask) tasks = tasks.filter(task => filterTask(task.projectId));
                return { tasks, succeeded: true, failure: "" };
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
            }
        }
        return { tasks: [] as any[], succeeded: false, failure };
    }
}
