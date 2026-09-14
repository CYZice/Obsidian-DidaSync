import { strict as assert } from "assert";
import { formatTaskLineFromTask } from "../src/taskLineFormat";
import {
    formatFullDate,
    formatMonthName,
    formatWeekdayLong,
    localizedProjectName,
    messages,
    resolveUiLanguage,
    translate,
    weekdayDate
} from "../src/i18n";

assert.deepEqual(Object.keys(messages.zh).sort(), Object.keys(messages.en).sort());

assert.equal(resolveUiLanguage("en", "zh-CN"), "en");
assert.equal(resolveUiLanguage("zh", "en-US"), "zh");
assert.equal(resolveUiLanguage("auto", "zh-CN"), "zh");
assert.equal(resolveUiLanguage(undefined, "en-US"), "en");
assert.equal(resolveUiLanguage("auto", "fr-FR"), "en");

assert.equal(translate("en", "taskView.taskMovedTo", { name: "Inbox" }), "Task moved to Inbox");
assert.equal(translate("zh", "taskView.taskMovedTo", { name: "收集箱" }), "任务已移动到 收集箱");
assert.equal(translate("en", "taskView.taskMovedTo", { name: null }), "Task moved to {name}");
assert.equal(translate("en", "taskView.headerTitle"), "TickTick");
assert.equal(translate("zh", "taskView.headerTitle"), "滴答清单");

assert.equal(localizedProjectName("收集箱", "en"), "Inbox");
assert.equal(localizedProjectName("收集箱", "zh"), "收集箱");
assert.equal(localizedProjectName("本地任务", "en"), "Local tasks");
assert.equal(localizedProjectName("Work", "en"), "Work");

const untitledTask = { title: "", status: 0, id: "task-1", didaId: "task-1" } as any;
assert.match(formatTaskLineFromTask(untitledTask, "", "", translate("en", "common.untitledTask")), /Untitled task/);
assert.match(formatTaskLineFromTask(untitledTask, "", "", translate("zh", "common.untitledTask")), /无标题任务/);

const date = new Date(2026, 0, 5, 12, 0, 0);
assert.equal(formatMonthName(0, "en"), "January");
assert.equal(formatMonthName(0, "zh"), "一月");
assert.equal(formatWeekdayLong(date, "en"), "Monday");
assert.equal(formatWeekdayLong(date, "zh"), "星期一");
assert.match(formatFullDate(date, "en"), /Jan 5, 2026/);
assert.match(formatFullDate(date, "zh"), /2026年1月5日/);
assert.equal(weekdayDate(0).getDay(), 0);

console.log("i18n tests passed");
