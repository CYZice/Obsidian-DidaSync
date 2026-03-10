import { WorkspaceLeaf } from 'obsidian';
import { TaskView } from './TaskView';
import DidaSyncPlugin from '../main';

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
        return "滴答时间线视图";
    }

    getIcon() {
        return "calendar-clock";
    }
}
