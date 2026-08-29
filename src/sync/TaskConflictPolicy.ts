import { PendingSyncOperation } from "../types";
import { resolveWholeEntityConflict, WholeEntityConflictDecision } from "./WholeEntityConflictPolicy";

export function resolvePendingTaskConflict(operation: PendingSyncOperation, remote: any): WholeEntityConflictDecision {
    return resolveWholeEntityConflict({
        localModifiedAt: operation.modifiedAt || operation.createdAt,
        remoteModifiedAt: remote?.modifiedTime || remote?.updatedTime || remote?.updateTime
    });
}

export function shouldPreferPendingLocalChange(operation: PendingSyncOperation, remote: any): boolean {
    return resolvePendingTaskConflict(operation, remote) === "local";
}
