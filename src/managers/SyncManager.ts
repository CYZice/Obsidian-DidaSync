import DidaSyncPlugin from "../main";
import { TaskSyncService } from "../sync/TaskSyncService";

/**
 * Backwards-compatible plugin facade. The synchronization implementation lives
 * in TaskSyncService and is orchestrated by UnifiedSyncEngine.
 */
export class SyncManager extends TaskSyncService {
    constructor(plugin: DidaSyncPlugin) {
        super(plugin);
    }
}
