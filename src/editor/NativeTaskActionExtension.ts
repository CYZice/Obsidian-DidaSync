import { Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { setIcon } from "obsidian";
import { parseTaskLine } from "../taskLineFormat";
import { Translator } from "../i18n";

class NativeTaskActionWidget extends WidgetType {
    constructor(
        private lineNumber: number,
        private linked: boolean,
        private onOpen: (lineNumber: number) => void,
        private t: Translator
    ) {
        super();
    }

    eq(other: NativeTaskActionWidget) {
        return other.lineNumber === this.lineNumber && other.linked === this.linked;
    }

    toDOM() {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "dida-native-task-action-widget";
        button.setAttribute("aria-label", this.t(this.linked ? "nativeTask.openActions" : "nativeTask.addToDida"));
        button.title = this.t(this.linked ? "nativeTask.openActions" : "nativeTask.addToDida");
        setIcon(button, this.linked ? "circle-check" : "circle-plus");
        button.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            this.onOpen(this.lineNumber);
        };
        return button;
    }

    ignoreEvent() {
        return true;
    }
}

function buildDecorations(view: EditorView, onOpen: (lineNumber: number) => void, enabled: () => boolean, t: Translator): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    if (!enabled()) return builder.finish();
    const seen = new Set<number>();
    for (const range of view.visibleRanges) {
        let position = range.from;
        while (position <= range.to) {
            const line = view.state.doc.lineAt(position);
            if (!seen.has(line.number)) {
                seen.add(line.number);
                const parsed = parseTaskLine(line.text);
                if (parsed?.checkbox === " ") {
                    builder.add(line.to, line.to, Decoration.widget({
                        widget: new NativeTaskActionWidget(line.number - 1, !!parsed.didaId, onOpen, t),
                        side: 1
                    }));
                }
            }
            if (line.to >= range.to) break;
            position = line.to + 1;
        }
    }
    return builder.finish();
}

export function createNativeTaskActionExtension(
    onOpen: (lineNumber: number) => void,
    enabled: () => boolean,
    t: Translator
): Extension {
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = buildDecorations(view, onOpen, enabled, t);
        }

        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged) {
                this.decorations = buildDecorations(update.view, onOpen, enabled, t);
            }
        }
    }, {
        decorations: value => value.decorations
    });
}
