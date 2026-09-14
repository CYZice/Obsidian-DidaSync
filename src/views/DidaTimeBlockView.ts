import { WorkspaceLeaf } from 'obsidian';
import DidaSyncPlugin from '../main';
import { TaskView } from './TaskView';

export const TIME_BLOCK_VIEW_TYPE = "dida-time-block-view";

export class DidaTimeBlockView extends TaskView {
    constructor(leaf: WorkspaceLeaf, plugin: DidaSyncPlugin) {
        super(leaf, plugin);
        this.viewMode = "timeblock";
    }

    getViewType() {
        return TIME_BLOCK_VIEW_TYPE;
    }

    getDisplayText() {
        return this.plugin.t("view.timeBlock.displayText");
    }

    getIcon() {
        return "calendar-check";
    }
}
