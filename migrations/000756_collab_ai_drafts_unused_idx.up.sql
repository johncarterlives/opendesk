-- A conversation lists its AI drafts that were discarded, replaced or abandoned each time it
-- opens, so feedback on them stays reachable (contracts/collab.md "AI draft outcomes").
CREATE INDEX IF NOT EXISTS collab_ai_drafts_thread_unused_idx ON collab_ai_drafts(thread_id)
    WHERE outcome IN ('discarded', 'replaced', 'abandoned');
