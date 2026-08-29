import { PendingSyncOperation } from "../types";

export function shouldPreferPendingLocalChange(operation: PendingSyncOperation, remote: any): boolean {
    const remoteModified = remote?.modifiedTime || remote?.updatedTime || remote?.updateTime;
    if (!remoteModified) return true;
    const remoteTime = Date.parse(remoteModified);
    const localTime = Date.parse(operation.modifiedAt || operation.createdAt);
    if (!Number.isFinite(remoteTime) || !Number.isFinite(localTime)) return true;
    return localTime >= remoteTime;
}
