import { DidaTask } from "./types";

export type CalendarMode = "day" | "week" | "month" | "year";

export interface CalendarDayCell {
    date: Date;
    key: string;
    inCurrentMonth: boolean;
}

export function getCalendarDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getCalendarMonthRange(displayDate: Date) {
    const startDate = new Date(displayDate.getFullYear(), displayDate.getMonth(), 1);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(displayDate.getFullYear(), displayDate.getMonth() + 1, 0);
    endDate.setHours(23, 59, 59, 999);
    return { startDate, endDate };
}

export function getCalendarWeekRange(displayDate: Date) {
    const startDate = new Date(displayDate);
    startDate.setHours(0, 0, 0, 0);
    const day = startDate.getDay();
    startDate.setDate(startDate.getDate() - (day === 0 ? 6 : day - 1));
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
    return { startDate, endDate };
}

export function getCalendarYearRange(displayDate: Date) {
    const startDate = new Date(displayDate.getFullYear(), 0, 1);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(displayDate.getFullYear(), 11, 31);
    endDate.setHours(23, 59, 59, 999);
    return { startDate, endDate };
}

export function buildCalendarMonthGrid(displayDate: Date, weekStartsOn: "monday" | "sunday" = "monday"): CalendarDayCell[] {
    const monthStart = new Date(displayDate.getFullYear(), displayDate.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);
    const gridStart = new Date(monthStart);
    const day = gridStart.getDay();
    gridStart.setDate(gridStart.getDate() - (weekStartsOn === "sunday" ? day : day === 0 ? 6 : day - 1));

    const monthEnd = new Date(displayDate.getFullYear(), displayDate.getMonth() + 1, 0);
    monthEnd.setHours(0, 0, 0, 0);
    const gridEnd = new Date(monthEnd);
    const endDay = gridEnd.getDay();
    gridEnd.setDate(gridEnd.getDate() + (weekStartsOn === "sunday" ? 6 - endDay : endDay === 0 ? 0 : 7 - endDay));

    const cells: CalendarDayCell[] = [];
    const cursor = new Date(gridStart);
    while (cursor.getTime() <= gridEnd.getTime()) {
        cells.push({
            date: new Date(cursor),
            key: getCalendarDateKey(cursor),
            inCurrentMonth: cursor.getMonth() === displayDate.getMonth()
        });
        cursor.setDate(cursor.getDate() + 1);
    }
    return cells;
}

export function getCalendarTaskDate(task: DidaTask, completed = false): Date | null {
    const rawDate = completed
        ? task.completedTime || task.startDate || task.dueDate
        : task.startDate || task.dueDate;
    if (!rawDate) return null;
    const date = new Date(rawDate);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function dedupeCalendarTasks(tasks: DidaTask[]): DidaTask[] {
    const indexesByKey = new Map<string, number>();
    const result: DidaTask[] = [];
    tasks.forEach((task) => {
        const key = task.didaId || task.id;
        if (key && indexesByKey.has(key)) {
            const existingIndex = indexesByKey.get(key)!;
            const existing = result[existingIndex];
            if (getCalendarTaskCompletenessScore(task) > getCalendarTaskCompletenessScore(existing)) {
                result[existingIndex] = task;
            }
            return;
        }
        if (key) indexesByKey.set(key, result.length);
        result.push(task);
    });
    return result;
}

function hasValidCompletedTime(task: DidaTask): boolean {
    if (!task.completedTime) return false;
    const date = new Date(task.completedTime);
    return !Number.isNaN(date.getTime());
}

function getCalendarTaskCompletenessScore(task: DidaTask): number {
    const fields: Array<keyof DidaTask> = [
        "title",
        "content",
        "desc",
        "projectId",
        "projectName",
        "startDate",
        "dueDate",
        "completedTime",
        "parentId",
        "createdAt",
        "updatedAt",
        "etag",
        "kind",
        "repeatFlag"
    ];
    const fieldScore = fields.reduce((score, field) => {
        const value = task[field];
        if (value === null || value === undefined || value === "") return score;
        return score + 1;
    }, 0);
    const collectionScore = (Array.isArray(task.items) ? task.items.length : 0)
        + (Array.isArray(task.reminders) ? task.reminders.length : 0);
    return (hasValidCompletedTime(task) ? 10000 : 0)
        + (task.status === 2 ? 1000 : 0)
        + fieldScore
        + collectionScore;
}

export function groupTasksByCalendarDate(tasks: DidaTask[], completed = false): Map<string, DidaTask[]> {
    const grouped = new Map<string, DidaTask[]>();
    tasks.forEach((task) => {
        const date = getCalendarTaskDate(task, completed);
        if (!date) return;
        const key = getCalendarDateKey(date);
        const items = grouped.get(key) || [];
        items.push(task);
        grouped.set(key, items);
    });
    return grouped;
}
