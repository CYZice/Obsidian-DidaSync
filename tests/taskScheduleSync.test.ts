import assert from "node:assert/strict";
import {
    applyTaskScheduleToPayload,
    areSameTaskDateTime,
    hasTaskTimeRange,
    mergeRemoteTaskSchedule,
    shouldPreserveCollapsedRemoteRange
} from "../src/taskScheduleSync";

const localRange = {
    startDate: "2026-08-29T09:00:00+0800",
    dueDate: "2026-08-29T10:30:00+0800",
    isAllDay: false,
    timeZone: "Asia/Shanghai",
    etag: "etag-1"
};

const payload = applyTaskScheduleToPayload({}, localRange, "UTC");
assert.equal(payload.startDate, localRange.startDate);
assert.equal(payload.dueDate, localRange.dueDate);
assert.equal(payload.timeZone, "Asia/Shanghai");
assert.equal(hasTaskTimeRange(localRange), true);
assert.equal(areSameTaskDateTime("2026-08-29T01:00:00Z", localRange.startDate), true);

const collapsedRemote = {
    startDate: "2026-08-29T10:30:00+0800",
    dueDate: "2026-08-29T10:30:00+0800",
    etag: "etag-1"
};
assert.equal(shouldPreserveCollapsedRemoteRange(localRange, collapsedRemote), true);
assert.deepEqual(mergeRemoteTaskSchedule(localRange, collapsedRemote), {
    startDate: localRange.startDate,
    dueDate: localRange.dueDate
});

const changedRemote = {
    startDate: "2026-08-29T11:00:00+0800",
    dueDate: "2026-08-29T12:00:00+0800",
    etag: "etag-2"
};
assert.deepEqual(mergeRemoteTaskSchedule(localRange, changedRemote), {
    startDate: changedRemote.startDate,
    dueDate: changedRemote.dueDate
});

console.log("task schedule sync tests passed");
