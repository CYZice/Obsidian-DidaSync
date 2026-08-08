import assert from "node:assert/strict";
import { ScopedPopup } from "../src/modals/TaskSchedulePicker";

class FakeElement {
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    className = "";
    styles: Record<string, string> = {};
    onclick: ((event?: unknown) => void) | null = null;

    createDiv(className: string = "") {
        const child = new FakeElement();
        child.className = className;
        child.parent = this;
        this.children.push(child);
        return child;
    }

    setCssStyles(styles: Record<string, string>) {
        Object.assign(this.styles, styles);
    }

    getBoundingClientRect() {
        return { top: 0, left: 0, right: 400, bottom: 600, width: 400, height: 600 };
    }

    contains(target: FakeElement) {
        let current: FakeElement | null = target;
        while (current) {
            if (current === this) return true;
            current = current.parent;
        }
        return false;
    }

    closest(selector: string) {
        let current: FakeElement | null = this;
        const className = selector.startsWith(".") ? selector.slice(1) : selector;
        while (current) {
            if (current.className.split(/\s+/).includes(className)) return current;
            current = current.parent;
        }
        return null;
    }
    stopPropagation() { }

    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }
}

const body = new FakeElement();
const listeners = new Map<string, Set<unknown>>();
const windowListeners = new Map<string, Set<unknown>>();
(globalThis as any).document = {
    body,
    visibilityState: "visible",
    addEventListener(type: string, listener: unknown) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: unknown) {
        listeners.get(type)?.delete(listener);
    }
};
(globalThis as any).window = {
    innerWidth: 400,
    innerHeight: 600,
    addEventListener(type: string, listener: unknown) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: unknown) {
        windowListeners.get(type)?.delete(listener);
    }
};
(globalThis as any).Element = FakeElement;

function emitDocument(type: string, event: unknown = {}) {
    for (const listener of listeners.get(type) || []) (listener as (event: unknown) => void)(event);
}

function emitWindow(type: string) {
    for (const listener of windowListeners.get(type) || []) (listener as () => void)();
}

const scope = new FakeElement();
const popup = new ScopedPopup(null, scope as any);
popup.open(container => {
    container.createDiv("calendar-content");
});
assert.ok(popup.container, "popup container should remain mounted after a successful render");
assert.equal(body.children.length, 2, "overlay and popup should both be mounted");
const inside = popup.container!.children[0];
emitDocument("pointerdown", { target: inside });
assert.ok(popup.container, "clicking inside the popup should keep it open");
const repeatOverlay = body.createDiv("dida-compact-repeat-overlay");
emitDocument("pointerdown", { target: repeatOverlay });
assert.ok(popup.container, "clicking the related repeat popup should keep the schedule popup open");
repeatOverlay.remove();
emitDocument("pointerdown", { target: new FakeElement() });
assert.equal(body.children.length, 0, "clicking elsewhere in Obsidian should close both popup layers");

const overlayFreePopup = new ScopedPopup(null, scope as any, "", false);
overlayFreePopup.open(container => container.createDiv("calendar-content"));
assert.ok(overlayFreePopup.container, "an overlay-free popup should remain mounted after rendering");
assert.equal(body.children.length, 1, "an overlay-free popup should only mount its content layer");
emitDocument("pointerdown", { target: new FakeElement() });
assert.equal(body.children.length, 0, "an overlay-free popup should close when clicking elsewhere");

const blurredPopup = new ScopedPopup(null, scope as any);
blurredPopup.open(container => container.createDiv("calendar-content"));
emitWindow("blur");
assert.equal(body.children.length, 0, "clicking outside Obsidian should close the popup on window blur");

const hiddenPopup = new ScopedPopup(null, scope as any);
hiddenPopup.open(container => container.createDiv("calendar-content"));
(globalThis as any).document.visibilityState = "hidden";
emitDocument("visibilitychange");
assert.equal(body.children.length, 0, "hiding the Obsidian window should close the popup");
(globalThis as any).document.visibilityState = "visible";

const failingPopup = new ScopedPopup(null, scope as any);
assert.throws(() => failingPopup.open(() => {
    throw new Error("render failed");
}), /render failed/);
assert.equal(body.children.length, 0, "a failed render must not leave an overlay behind");
assert.equal(ScopedPopup.activePopup, null);
assert.equal(listeners.get("pointerdown")?.size || 0, 0, "outside-click listeners should be removed after close");
assert.equal(listeners.get("visibilitychange")?.size || 0, 0, "visibility listeners should be removed after close");
assert.equal(windowListeners.get("blur")?.size || 0, 0, "window blur listeners should be removed after close");

console.log("Task schedule popup tests passed");
