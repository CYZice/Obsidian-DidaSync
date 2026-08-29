import { fetchCompletedTasksByRange } from "../completedTaskCache";
import { ensureTaskCompletedTime, normalizeRemoteCompletedTime } from "../taskCompletion";
import { DidaTask } from "../types";

export type RemoteTaskVerification =
    | { kind: "completed"; data?: any }
    | { kind: "not_found" }
    | { kind: "still_active"; data?: any }
    | { kind: "uncertain"; error?: unknown; httpStatus?: number };

export interface ReverseCompletionMeta {
    missingStreak: number;
    lastSeenAt: string | null;
    lastMissingAt: string | null;
}

interface MissingTaskVerificationOptions {
    getMeta(didaId: string): ReverseCompletionMeta;
    verifyTask(task: DidaTask): Promise<RemoteTaskVerification>;
    verifyBudget: { value: number };
    now?: Date;
}

interface ReconcileMissingRemoteTasksOptions extends MissingTaskVerificationOptions {
    localTasks: DidaTask[];
    activeRemoteTasks: any[];
    hasPendingOperation(task: DidaTask): boolean;
    isNoteTask(task: DidaTask): boolean;
    fetchCompletedTasks(query: { projectIds?: string[]; startDate: string; endDate: string }): Promise<any[]>;
}

export async function verifyMissingRemoteTask(task: DidaTask, options: MissingTaskVerificationOptions): Promise<boolean> {
    if (!task.didaId) return false;
    const now = options.now || new Date();
    const meta = options.getMeta(task.didaId);
    meta.missingStreak = (meta.missingStreak || 0) + 1;
    meta.lastMissingAt = now.toISOString();
    if (options.verifyBudget.value <= 0) return false;
    options.verifyBudget.value--;

    const result = await options.verifyTask(task);
    if (result.kind === "still_active") {
        task.remoteDeleted = false;
        meta.missingStreak = 0;
        meta.lastSeenAt = now.toISOString();
        return false;
    }
    if (result.kind === "completed") {
        task.remoteDeleted = false;
        task.status = 2;
        task.completedTime = normalizeRemoteCompletedTime(result.data?.completedTime);
        ensureTaskCompletedTime(task);
        task.updatedAt = now.toISOString();
        return true;
    }
    if (result.kind === "not_found") {
        task.remoteDeleted = true;
        task.updatedAt = now.toISOString();
        return true;
    }
    return false;
}

export async function reconcileMissingRemoteTasks(options: ReconcileMissingRemoteTasksOptions): Promise<number> {
    const activeRemoteIds = new Set(options.activeRemoteTasks.map(task => task.id));
    const missingTasks = options.localTasks.filter(task =>
        !!task.didaId
        && task.status !== 2
        && !activeRemoteIds.has(task.didaId)
        && !options.hasPendingOperation(task)
        && !options.isNoteTask(task)
    );
    if (missingTasks.length === 0) return 0;

    const now = options.now || new Date();
    const candidateTimes = missingTasks
        .map(task => {
            const meta = options.getMeta(task.didaId as string);
            return meta.lastSeenAt || task.updatedAt || task.createdAt || null;
        })
        .map(value => value ? new Date(value).getTime() : NaN)
        .filter(value => Number.isFinite(value));
    const fallbackStart = now.getTime() - 90 * 24 * 60 * 60 * 1000;
    const earliestCandidateTime = candidateTimes.length > 0 ? Math.min(...candidateTimes) : fallbackStart;
    const startDate = new Date(Math.min(now.getTime(), earliestCandidateTime) - 24 * 60 * 60 * 1000);
    const completedResult = await fetchCompletedTasksByRange(
        { startDate, endDate: now },
        options.fetchCompletedTasks
    );
    if (completedResult.truncatedSegments.length > 0) {
        throw new Error("已完成任务记录不完整，跳过缺失任务清理");
    }

    const completedById = new Map<string, any>();
    for (const completedTask of completedResult.tasks) {
        const id = String(completedTask?.id || completedTask?.didaId || "").trim();
        if (id) completedById.set(id, completedTask);
    }

    let changedCount = 0;
    for (const task of missingTasks) {
        const completedTask = completedById.get(task.didaId as string);
        if (completedTask) {
            task.remoteDeleted = false;
            task.status = 2;
            task.completedTime = normalizeRemoteCompletedTime(completedTask.completedTime);
            ensureTaskCompletedTime(task);
            task.updatedAt = now.toISOString();
            changedCount++;
            continue;
        }
        try {
            if (await verifyMissingRemoteTask(task, { ...options, now })) changedCount++;
        } catch (_error) { }
    }
    return changedCount;
}
