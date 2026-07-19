import { strict as assert } from "assert";
import { formatTaskLine, formatTaskLineFromTask, parseTaskLine } from "../src/taskLineFormat";

const didaId = "6a24462bc500bf31a90ce7dd";

{
    const parsed = parseTaskLine(`- [ ] 数电MOOC [Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`);
    assert.ok(parsed);
    assert.equal(parsed.quotePrefix, "");
    assert.equal(parsed.checkbox, " ");
    assert.equal(parsed.title, "数电MOOC");
    assert.equal(parsed.didaId, didaId);
    assert.ok(parsed.dueDate?.includes("2026-06-09"));
}

{
    const parsed = parseTaskLine(`> - [x] 数电MOOC [Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`);
    assert.ok(parsed);
    assert.equal(parsed.quotePrefix, "> ");
    assert.equal(parsed.checkbox, "x");
    assert.equal(parsed.title, "数电MOOC");
    assert.equal(parsed.didaId, didaId);
    assert.ok(parsed.dueDate?.includes("2026-06-09"));
}

{
    const parsed = parseTaskLine(`> > - [ ] 嵌套任务 [🔗Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`);
    assert.ok(parsed);
    assert.equal(parsed.quotePrefix, "> > ");
    assert.equal(parsed.title, "嵌套任务");
    assert.equal(parsed.didaId, didaId);
}

{
    const line = `> - [ ] 数电MOOC [Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`;
    const updated = formatTaskLine(line, {
        checkbox: "x",
        title: "数字电路 MOOC",
        dueDate: "2026-06-10T00:00:00+0800",
        isAllDay: true
    });
    assert.ok(updated.startsWith("> - [x] 数字电路 MOOC "));
    assert.ok(updated.includes(`didaId=${didaId}`));
    assert.ok(updated.includes("2026-06-10"));
}

{
    const line = formatTaskLineFromTask({
        id: "local-id",
        title: "完整任务",
        status: 0,
        didaId,
        dueDate: "2026-06-09T00:00:00+0800",
        startDate: "2026-06-09T00:00:00+0800",
        isAllDay: true,
        priority: 3,
        repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1"
    } as any, "", "> ");
    assert.ok(line.startsWith("> - [ ] 完整任务 "));
    assert.ok(line.includes(`didaId=${didaId}`));
    assert.ok(line.includes("2026-06-09"));
    assert.ok(line.includes("🚩中"));
    assert.ok(line.includes("every week"));
}

{
    const lines = [
        `> - [ ] 旧标题 [Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`,
        `> - [ ] 新标题 [Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`
    ];
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        lines[i] = formatTaskLine(line, { title: "新标题" });
        updated = updated || lines[i] !== line;
    }
    assert.equal(updated, true);
    assert.ok(lines[0].includes("新标题"));
    assert.ok(lines[1].includes("新标题"));
}

{
    const lines = [
        `> - [ ] 任务 [Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`,
        `> - [ ] 任务 [Dida](obsidian://dida-task?didaId=${didaId}) 📅 2026-06-10`
    ];
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        lines[i] = formatTaskLine(line, {
            dueDate: "2026-06-10T00:00:00+0800",
            isAllDay: true
        });
        updated = updated || lines[i] !== line;
    }
    assert.equal(updated, true);
    assert.ok(lines.every(line => line.includes("2026-06-10")));
}

{
    const line = `> - [ ] 时间段任务 [Dida](obsidian://dida-task?didaId=${didaId}) 📅 2026-06-09`;
    const updated = formatTaskLine(line, {
        startDate: "2026-06-10T09:30:00+0800",
        dueDate: "2026-06-10T11:15:00+0800",
        isAllDay: false,
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1"
    });
    assert.ok(updated.includes("[09:30 - 11:15]"));
    assert.ok(updated.includes("📅 2026-06-10"));
    assert.ok(updated.includes("every day"));
}

{
    const parsed = parseTaskLine("- [ ] 项目任务 ^[Project Alpha] 🚩高");
    assert.equal(parsed?.title, "项目任务");
    assert.equal(parsed?.projectName, "Project Alpha");
    assert.equal(parsed?.priority, 5);
    const formatted = formatTaskLine("- [ ] 项目任务 ^PROJECT 🔴", {});
    assert.equal(formatted, "- [ ] 项目任务 🚩高 ^PROJECT");
}

{
    const updated = formatTaskLine("- [ ] 只设置日期", {
        startDate: "2026-06-10T00:00:00+0800",
        dueDate: "2026-06-10T00:00:00+0800",
        isAllDay: true
    });
    assert.equal(updated, "- [ ] 只设置日期 📅 2026-06-10");
}

{
    const disconnected = formatTaskLine(`- [ ] 已删除任务 [Dida](obsidian://dida-task?didaId=${didaId})`, {
        didaId: null,
        disconnected: true
    });
    assert.equal(disconnected, "- [ ] 已删除任务 🗑️");
    const parsed = parseTaskLine(disconnected);
    assert.equal(parsed?.title, "已删除任务");
    assert.equal(parsed?.didaId, null);
    assert.equal(parsed?.disconnected, true);
}

{
    const line = `> - [ ] 清除日期 [Dida](obsidian://dida-task?didaId=${didaId}) [09:30 - 11:15] 📅 2026-06-10 🔁 every day`;
    const updated = formatTaskLine(line, {
        startDate: null,
        dueDate: null,
        isAllDay: false,
        repeatFlag: null
    });
    assert.ok(!updated.includes("[09:30 - 11:15]"));
    assert.ok(!updated.includes("📅"));
    assert.ok(!updated.includes("every day"));
}

{
    const lines = [
        `> - [ ] 任务 [Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`,
        `> - [x] 任务 [Dida](obsidian://dida-task?didaId=${didaId}) 2026-06-09`
    ];
    let updated = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        lines[i] = formatTaskLine(line, { checkbox: "x" });
        updated = updated || lines[i] !== line;
    }
    assert.equal(updated, true);
    assert.ok(lines.every(line => line.startsWith("> - [x]")));
}

console.log("taskLineFormat tests passed");
