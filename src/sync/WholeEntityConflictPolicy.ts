export type WholeEntityConflictDecision = "local" | "remote" | "unresolvable";

export interface WholeEntityConflictInput {
    localModifiedAt?: string | number | null;
    remoteModifiedAt?: string | number | null;
}

function parseTimestamp(value: string | number | null | undefined): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function resolveWholeEntityConflict(input: WholeEntityConflictInput): WholeEntityConflictDecision {
    const localTime = parseTimestamp(input.localModifiedAt);
    const remoteTime = parseTimestamp(input.remoteModifiedAt);
    if (localTime === null || remoteTime === null) return "unresolvable";
    return localTime > remoteTime ? "local" : "remote";
}
