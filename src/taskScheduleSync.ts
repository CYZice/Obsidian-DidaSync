import { DidaTask } from "./types";

type TaskScheduleFields = Pick<DidaTask, "startDate" | "dueDate" | "isAllDay" | "timeZone">;

function normalizePayloadDate(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString().replace(/Z$/, "+0000");
    if (typeof value === "string" && value.endsWith("Z")) return value.replace(/Z$/, "+0000");
    return value;
}

export function applyTaskScheduleToPayload(payload: Record<string, any>, schedule: TaskScheduleFields, fallbackTimeZone: string) {
    if (schedule.dueDate !== undefined) payload.dueDate = normalizePayloadDate(schedule.dueDate);
    if (schedule.startDate !== undefined) payload.startDate = normalizePayloadDate(schedule.startDate);
    if (schedule.isAllDay !== undefined) payload.isAllDay = schedule.isAllDay;
    if (payload.startDate || payload.dueDate) {
        payload.timeZone = schedule.timeZone || fallbackTimeZone;
    }
    return payload;
}

export function areSameTaskDateTime(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    const leftTime = new Date(left as any).getTime();
    const rightTime = new Date(right as any).getTime();
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

export function hasTaskTimeRange(schedule: Pick<TaskScheduleFields, "startDate" | "dueDate">): boolean {
    return !!(schedule.startDate && schedule.dueDate && !areSameTaskDateTime(schedule.startDate, schedule.dueDate));
}

export function shouldPreserveCollapsedRemoteRange(
    local: Pick<TaskScheduleFields, "startDate" | "dueDate"> & { etag?: string },
    remote: Pick<TaskScheduleFields, "startDate" | "dueDate"> & { etag?: string }
): boolean {
    if (!hasTaskTimeRange(local) || !remote.startDate || !remote.dueDate) return false;
    if (!areSameTaskDateTime(remote.startDate, remote.dueDate)) return false;
    if (!areSameTaskDateTime(local.dueDate, remote.dueDate)) return false;
    return !local.etag || !remote.etag || local.etag === remote.etag;
}

export function mergeRemoteTaskSchedule<T extends Pick<TaskScheduleFields, "startDate" | "dueDate"> & { etag?: string }>(
    local: T,
    remote: Partial<T>
): Pick<TaskScheduleFields, "startDate" | "dueDate"> {
    if (shouldPreserveCollapsedRemoteRange(local, remote as T)) {
        return { startDate: local.startDate, dueDate: local.dueDate };
    }
    return {
        startDate: remote.startDate !== undefined ? remote.startDate : local.startDate,
        dueDate: remote.dueDate !== undefined ? remote.dueDate : local.dueDate
    };
}
