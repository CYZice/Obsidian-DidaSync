export function formatCompletedTime(date: Date = new Date()): string {
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
    return `${y}-${m}-${d}T${h}:${min}:${s}${tz}`;
}

export function normalizeRemoteCompletedTime(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : formatCompletedTime(date);
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : formatCompletedTime(value);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const date = new Date(trimmed);
        return Number.isNaN(date.getTime()) ? null : trimmed;
    }
    return null;
}

export function ensureTaskCompletedTime<T extends { status?: number; completedTime?: string | null }>(
    task: T,
    date: Date = new Date()
): string | null {
    if (!task || task.status !== 2) return task?.completedTime || null;
    const existing = normalizeRemoteCompletedTime(task.completedTime);
    task.completedTime = existing || formatCompletedTime(date);
    return task.completedTime;
}
