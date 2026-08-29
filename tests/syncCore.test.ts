import assert from "node:assert/strict";
import { reconcileMissingRemoteTasks } from "../src/sync/RemoteTaskReconciler";
import { SyncRunCoordinator } from "../src/sync/SyncRunCoordinator";
import { shouldPreferPendingLocalChange } from "../src/sync/TaskConflictPolicy";
import { resolvePendingTaskConflict } from "../src/sync/TaskConflictPolicy";
import { resolveWholeEntityConflict } from "../src/sync/WholeEntityConflictPolicy";
import { UnifiedSyncEngine } from "../src/sync/UnifiedSyncEngine";
import { SyncOutbox } from "../src/sync/SyncOutbox";

type Result = { outcome: "success" | "failed" | "skipped"; runs: number; errors: string[] };

async function testRunCoordinator() {
    let releaseFirstRun: (() => void) | null = null;
    const firstRunGate = new Promise<void>(resolve => { releaseFirstRun = resolve; });
    let runCount = 0;
    const coordinator = new SyncRunCoordinator<Result>({
        timeoutMs: 1000,
        createSkippedResult: () => ({ outcome: "skipped", runs: 0, errors: [] }),
        createFailureResult: error => ({ outcome: "failed", runs: 0, errors: [String(error)] }),
        mergeResults: (current, next) => ({
            outcome: current.outcome === "failed" || next.outcome === "failed" ? "failed" : "success",
            runs: current.runs + next.runs,
            errors: [...current.errors, ...next.errors]
        }),
        runOnce: async context => {
            runCount++;
            context.setPhase("downloading", "pull");
            if (runCount === 1) await firstRunGate;
            return { outcome: "success", runs: 1, errors: [] };
        }
    });

    const first = coordinator.run();
    await Promise.resolve();
    const queued = coordinator.run();
    assert.equal(coordinator.getState().queued, true);
    releaseFirstRun?.();
    const [firstResult, queuedResult] = await Promise.all([first, queued]);
    assert.equal(runCount, 2);
    assert.equal(firstResult.runs, 2);
    assert.equal(queuedResult.runs, 2);
    assert.equal(coordinator.getState().isRunning, false);

    const timeoutCoordinator = new SyncRunCoordinator<Result>({
        timeoutMs: 10,
        createSkippedResult: () => ({ outcome: "skipped", runs: 0, errors: [] }),
        createFailureResult: error => ({ outcome: "failed", runs: 0, errors: [(error as Error).message] }),
        mergeResults: (_current, next) => next,
        runOnce: async () => await new Promise<Result>(() => { })
    });
    const timedOut = await timeoutCoordinator.run();
    assert.equal(timedOut.outcome, "failed");
    assert.match(timedOut.errors[0], /同步运行超时/);
    assert.equal(timeoutCoordinator.getState().isRunning, false);
}

async function testConflictPolicy() {
    const operation = {
        localTaskId: "local",
        type: "upsert" as const,
        createdAt: "2026-08-29T10:00:00Z",
        modifiedAt: "2026-08-29T12:00:00Z",
        attempts: 0
    };
    assert.equal(shouldPreferPendingLocalChange(operation, { modifiedTime: "2026-08-29T11:00:00Z" }), true);
    assert.equal(shouldPreferPendingLocalChange(operation, { modifiedTime: "2026-08-29T13:00:00Z" }), false);
    assert.equal(resolvePendingTaskConflict(operation, {}), "unresolvable");
    assert.equal(resolveWholeEntityConflict({ localModifiedAt: operation.modifiedAt, remoteModifiedAt: operation.modifiedAt }), "remote");
}

async function testUnifiedEngineScopeIsolation() {
    let taskRuns = 0;
    let noteRuns = 0;
    const engine = new UnifiedSyncEngine({
        taskScope: {
            runTaskScope: async () => {
                taskRuns++;
                return { outcome: "success", uploaded: 1, downloaded: 2, failedScopes: [], failedOperations: [], cleanupPerformed: true };
            }
        },
        noteScope: {
            syncNow: async () => {
                noteRuns++;
                throw new Error("note scope failed");
            }
        },
        shouldRunNotes: () => true
    });
    const all = await engine.run({ source: "manual", scope: "all" });
    assert.equal(all.outcome, "partial");
    assert.equal(all.uploaded, 1);
    assert.equal(all.downloaded, 2);
    assert.deepEqual(all.scopeResults?.map(scope => scope.key), ["tasks", "notes"]);
    const tasksOnly = await engine.run({ source: "manual", scope: "tasks" });
    assert.equal(tasksOnly.outcome, "success");
    assert.equal(taskRuns, 2);
    assert.equal(noteRuns, 1);
}

async function testPersistentOutboxState() {
    const host: any = { settings: { pendingSyncOperations: [] }, saveSettings: async () => { } };
    const outbox = new SyncOutbox(host);
    const task: any = { id: "local-1", didaId: "remote-1", projectId: "p1", title: "Task" };
    await outbox.enqueue(task, "upsert", { title: "Task" });
    const operation = outbox.list()[0];
    assert.equal(operation.state, "pending");
    assert.ok(operation.fingerprint);
    await outbox.markStarted(operation);
    assert.equal(operation.state, "uncertain");
    await outbox.markFailed(operation, new Error("network"));
    assert.equal(operation.state, "uncertain");
    assert.equal(operation.attempts, 1);
    assert.ok(operation.nextRetryAt);
}

async function testRemoteReconciler() {
    const completed: any = { id: "local-completed", didaId: "remote-completed", projectId: "p1", title: "completed", content: "", status: 0 };
    const deleted: any = { id: "local-deleted", didaId: "remote-deleted", projectId: "p1", title: "deleted", content: "", status: 0 };
    const active: any = { id: "local-active", didaId: "remote-active", projectId: "p1", title: "active", content: "", status: 0 };
    const metadata: Record<string, any> = {};
    const changed = await reconcileMissingRemoteTasks({
        localTasks: [completed, deleted, active],
        activeRemoteTasks: [],
        hasPendingOperation: () => false,
        isNoteTask: () => false,
        getMeta: didaId => metadata[didaId] ||= { missingStreak: 0, lastSeenAt: null, lastMissingAt: null },
        fetchCompletedTasks: async () => [{ id: "remote-completed", completedTime: "2026-08-29T12:00:00Z" }],
        verifyTask: async task => task.didaId === "remote-deleted"
            ? { kind: "not_found" }
            : { kind: "still_active", data: { id: task.didaId } },
        verifyBudget: { value: 20 },
        now: new Date("2026-08-29T14:00:00Z")
    });
    assert.equal(changed, 2);
    assert.equal(completed.status, 2);
    assert.equal(completed.remoteDeleted, false);
    assert.equal(deleted.remoteDeleted, true);
    assert.equal(active.remoteDeleted, false);
    assert.equal(metadata["remote-active"].missingStreak, 0);
}

async function run() {
    await testRunCoordinator();
    await testConflictPolicy();
    await testUnifiedEngineScopeIsolation();
    await testPersistentOutboxState();
    await testRemoteReconciler();
    console.log("sync core module tests passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
