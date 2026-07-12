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
    const manager = new NativeTaskSyncManager({ settings: { nativeTaskRemarkFormat: "--- ${remark}" } } as any);
    const content = [
        "- [ ] Plain task 📅 2026-06-24 🔴",
        "   --- https://example.com/note",
        "   --- second note",
        "  - [x] Timed linked [🔗Dida](obsidian://dida-task?didaId=abc123) [09:00 - 10:30] 📅 2026-06-25 🔁 every week",
        "```",
        "- [ ] ignored in code",
        "```",
        "- [ ] `ignored inline`",
        "> - [ ] Quote task [Dida](obsidian://dida-task?didaId=def456) 2026-06-26"
    ].join("\n");

    const tasks = manager.detectNativeTasks(content, "Daily.md");
    assert.equal(tasks.length, 3);
    assert.equal(tasks[0].title, "Plain task");
    assert.equal(tasks[0].remark, "https://example.com/note\nsecond note");
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
    assert.equal(manager.generateTaskId("A B.md", 2, "hello!"), "A_B_md_2_hello_");
    assert.deepEqual(manager.normalizeAutoSyncTags("dida #work，next"), ["#dida", "#work", "#next"]);
    assert.deepEqual(manager.normalizeAutoSyncMarkers("dida #work，🚀"), ["dida", "#work", "🚀"]);
    assert.equal(manager.fileMatchesAutoSyncTags("#dida\n- [ ] Plain task", "#dida"), false);
    assert.equal(manager.fileMatchesAutoSyncTags("- [ ] Plain task", "#dida", { frontmatter: { tags: ["dida"] } }), true);
    assert.equal(manager.fileMatchesAutoSyncTags("- [ ] Plain task", "#dida", { tags: [{ tag: "#dida/project" }] }), false);
    assert.equal(manager.fileMatchesAutoSyncTags("- [ ] Plain task", ""), false);
    assert.equal(manager.lineMatchesAutoSyncMarker("- [ ] Plain task #dida", "#dida"), true);
    assert.equal(manager.lineMatchesAutoSyncMarker("- [ ] Plain task #dida/project", "#dida"), false);
    assert.equal(manager.lineMatchesAutoSyncMarker("- [ ] Plain task #dida", "dida"), true);
    assert.equal(manager.lineMatchesAutoSyncMarker("- [ ] Plain task 🚀", "🚀"), true);
    assert.equal(manager.lineMatchesAutoSyncMarker("- [ ] Plain task dida", "dida"), false);
    assert.equal(manager.extractRemarkForTask(["- [ ] Task", "  %% custom note"], 0, "", "%% ${remark}"), "custom note");
    assert.equal(manager.extractRemarkForTask(["- [ ] Task", "  --- note", "  - [ ] child"], 0, "", "--- ${remark}"), "note");
    assert.equal(manager.extractRemarkForTask(["- [ ] Task", "--- 多少度", "--- 是的是的是"], 0, "", "--- ${remark}"), "多少度\n是的是的是");
    assert.equal(manager.extractRemarkForTask(["- [ ] Task", "  --- note"], 0, "", ""), "");
    assert.ok(manager.withDidaLink(content, 0, "new123").split("\n")[0].includes("didaId=new123"));
    assert.equal(manager.withDidaLink(content, 1, "new123"), content);

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
