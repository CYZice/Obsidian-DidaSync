import { buildCalendarMonthGrid, dedupeCalendarTasks, getCalendarDateKey, getCalendarMonthRange, getCalendarWeekRange, getCalendarYearRange, groupTasksByCalendarDate } from "../src/calendarMonth";
import { DidaTask } from "../src/types";

function assertEqual(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

function task(partial: Partial<DidaTask>): DidaTask {
    return {
        id: partial.id || "local",
        didaId: partial.didaId,
        title: partial.title || "Task",
        content: "",
        status: partial.status ?? 0,
        projectId: "inbox",
        startDate: partial.startDate,
        dueDate: partial.dueDate,
        completedTime: partial.completedTime,
        parentId: partial.parentId || null
    };
}

const june2026 = new Date(2026, 5, 15);
const grid = buildCalendarMonthGrid(june2026);
assertEqual(grid.length, 35, "June 2026 renders as 5 weeks");
assertEqual(getCalendarDateKey(grid[0].date), "2026-06-01", "month starting Monday begins on the first day");
assertEqual(getCalendarDateKey(grid[34].date), "2026-07-05", "grid fills through Sunday");

const august2026Grid = buildCalendarMonthGrid(new Date(2026, 7, 12));
assertEqual(august2026Grid.length, 42, "August 2026 renders as 6 weeks");
assertEqual(getCalendarDateKey(august2026Grid[0].date), "2026-07-27", "grid starts on Monday");

const sundayGrid = buildCalendarMonthGrid(june2026, "sunday");
assertEqual(getCalendarDateKey(sundayGrid[0].date), "2026-05-31", "Sunday-start grid starts on Sunday");
assertEqual(getCalendarDateKey(sundayGrid[4].date), "2026-06-04", "Sunday-start grid keeps weekdays aligned");

const range = getCalendarMonthRange(june2026);
assertEqual(range.startDate.toISOString(), new Date(2026, 5, 1, 0, 0, 0, 0).toISOString(), "month range start");
assertEqual(range.endDate.toISOString(), new Date(2026, 5, 30, 23, 59, 59, 999).toISOString(), "month range end");

const weekRange = getCalendarWeekRange(new Date(2026, 6, 22, 14, 30));
assertEqual(weekRange.startDate.toISOString(), new Date(2026, 6, 20, 0, 0, 0, 0).toISOString(), "week range starts on Monday");
assertEqual(weekRange.endDate.toISOString(), new Date(2026, 6, 26, 23, 59, 59, 999).toISOString(), "week range ends on Sunday");

const yearRange = getCalendarYearRange(june2026);
assertEqual(yearRange.startDate.toISOString(), new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(), "year range start");
assertEqual(yearRange.endDate.toISOString(), new Date(2026, 11, 31, 23, 59, 59, 999).toISOString(), "year range end");

const pendingByDate = groupTasksByCalendarDate([
    task({ id: "a", startDate: new Date(2026, 5, 10, 9).toISOString() }),
    task({ id: "b", dueDate: new Date(2026, 5, 11, 18).toISOString() })
]);
assertEqual(pendingByDate.get("2026-06-10")?.length, 1, "pending task uses startDate");
assertEqual(pendingByDate.get("2026-06-11")?.length, 1, "pending task falls back to dueDate");

const completedByDate = groupTasksByCalendarDate([
    task({
        id: "c",
        status: 2,
        startDate: new Date(2026, 5, 2, 9).toISOString(),
        completedTime: new Date(2026, 5, 12, 20).toISOString()
    })
], true);
assertEqual(completedByDate.get("2026-06-12")?.length, 1, "completed task uses completedTime");
assertEqual(completedByDate.get("2026-06-02"), undefined, "completed task does not use startDate first");

const deduped = dedupeCalendarTasks([
    task({ id: "local-a", didaId: "remote-a" }),
    task({ id: "remote-a", didaId: "remote-a" }),
    task({ id: "local-b" })
]);
assertEqual(deduped.length, 2, "tasks are deduped by didaId/id");

const dedupedCompletedCache = dedupeCalendarTasks([
    task({ id: "local-completed", didaId: "remote-completed", status: 2, parentId: "parent-remote" }),
    task({
        id: "cached-completed",
        didaId: "remote-completed",
        status: 2,
        parentId: "parent-remote",
        completedTime: "2026-06-20T10:00:00+0800"
    })
]);
assertEqual(dedupedCompletedCache.length, 1, "completed cache conflict is still deduped");
assertEqual(dedupedCompletedCache[0].id, "cached-completed", "completed cache with valid completedTime wins over incomplete local record");
assertEqual(dedupedCompletedCache[0].parentId, "parent-remote", "subtask structure survives completed cache dedupe");

const dedupedCompletedBothDated = dedupeCalendarTasks([
    task({
        id: "local-dated",
        didaId: "remote-dated",
        status: 2,
        completedTime: "2026-06-21T10:00:00+0800"
    }),
    {
        ...task({
            id: "cached-dated",
            didaId: "remote-dated",
            status: 2,
            completedTime: "2026-06-21T10:00:00+0800"
        }),
        content: "full",
        desc: "full",
        projectName: "Project",
        updatedAt: "2026-06-21T11:00:00+0800"
    }
]);
assertEqual(dedupedCompletedBothDated[0].id, "cached-dated", "more complete completed record wins when both have completedTime");

console.log("calendarMonth tests passed");
