import assert from "node:assert/strict";
import Module from "node:module";

const originalLoad = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "../main" || request.endsWith("/main")) {
        return class DidaSyncPlugin { };
    }
    return originalLoad.call(this, request, parent, isMain);
};

async function run() {
    (globalThis as any).navigator = { onLine: true };
    (globalThis as any).window = {
        addEventListener(event: string, cb: () => void) {
            if (event === "offline") (this as any).offline = cb;
            if (event === "online") (this as any).online = cb;
        }
    };

    const { NativeTaskSyncManager } = require("../src/managers/NativeTaskSyncManager");
    const manager = new NativeTaskSyncManager({} as any);
    const content = [
        "- [ ] Plain task 📅 2026-06-24 🔴",
        "  - [x] Timed linked [🔗Dida](obsidian://dida-task?didaId=abc123) [09:00 - 10:30] 📅 2026-06-25 🔁 every week",
        "```",
        "- [ ] ignored in code",
        "```",
        "- [ ] `ignored inline`",
        "> - [ ] Quote task [Dida](obsidian://dida-task?didaId=def456) 2026-06-26",
        "- [ ] Disconnected task 🗑️"
    ].join("\n");

    const tasks = manager.detectNativeTasks(content, "Daily.md");
    assert.equal(tasks.length, 4);
    assert.equal(tasks[0].title, "Plain task");
    assert.equal(tasks[0].priority, 5);
    assert.equal(tasks[0].taskDate, "2026-06-24");
    assert.equal(tasks[1].isCompleted, true);
    assert.equal(tasks[1].indent, "  ");
    assert.equal(tasks[1].didaId, "abc123");
    assert.equal(tasks[1].isAllDay, false);
    assert.match(tasks[1].startDate || "", /T09:00:00/);
    assert.match(tasks[1].dueDate || "", /T10:30:00/);
    assert.equal(tasks[1].repeatFlag, "RRULE:FREQ=WEEKLY;INTERVAL=1");
    assert.equal(tasks[2].didaId, "def456");
    assert.equal(tasks[3].title, "Disconnected task");
    assert.equal(tasks[3].hasLink, false);
    assert.equal(manager.generateTaskId("A B.md", 2, "hello!"), "A_B_md_2_hello_");

    (globalThis as any).window.offline();
    assert.equal(manager.getNetworkStatus(), false);
    (globalThis as any).window.online();
    assert.equal(manager.checkNetworkConnection(), true);

    console.log("NativeTaskSyncManager detection tests passed");
}

run()
    .finally(() => {
        (Module as any)._load = originalLoad;
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
