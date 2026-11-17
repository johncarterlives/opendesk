package imports

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// undoBatch is how many rows one undo transaction removes.
const undoBatch = 200

type undoWorker struct {
	river.WorkerDefaults[jobs.ImportUndoArgs]
	s *Service
}

func (w *undoWorker) Timeout(*river.Job[jobs.ImportUndoArgs]) time.Duration {
	return runBudget + 5*time.Minute
}

func (w *undoWorker) Work(ctx context.Context, job *river.Job[jobs.ImportUndoArgs]) error {
	return w.s.undo(ctx, job.Args)
}

// undoSteps remove what an import created, in this order: tickets go first so the
// contacts, companies and labels they used can be checked for other uses.
var undoSteps = []struct {
	kind string
	// remove deletes the rows among ids that may go and returns the storage keys of
	// their files. Every statement is scoped by workspace ($1).
	remove string
}{
	{"ticket", `DELETE FROM tickets WHERE workspace_id = $1 AND id = ANY($2)`},
	{"contact", `DELETE FROM contacts c WHERE c.workspace_id = $1 AND c.id = ANY($2)
		AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.contact_id = c.id)
		AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.author_contact_id = c.id)`},
	{"company", `DELETE FROM companies c WHERE c.workspace_id = $1 AND c.id = ANY($2)
		AND NOT EXISTS (SELECT 1 FROM contacts x WHERE x.company_id = c.id)`},
	{"tag", `DELETE FROM tags g WHERE g.workspace_id = $1 AND g.id = ANY($2)
		AND NOT EXISTS (SELECT 1 FROM ticket_tags x WHERE x.tag_id = g.id)
		AND NOT EXISTS (SELECT 1 FROM contact_tags x WHERE x.tag_id = g.id)
		AND NOT EXISTS (SELECT 1 FROM company_tags x WHERE x.tag_id = g.id)`},
	{"article", `DELETE FROM kb_articles WHERE workspace_id = $1 AND id = ANY($2)`},
	{"collection", `DELETE FROM kb_collections k WHERE k.workspace_id = $1 AND k.id = ANY($2)
		AND NOT EXISTS (SELECT 1 FROM kb_articles a WHERE a.collection_id = k.id)`},
}

// undo removes an import's rows in batches, then forgets what it recorded.
func (s *Service) undo(ctx context.Context, args jobs.ImportUndoArgs) error {
	x, err := loadByID(ctx, s.d.DB.Pool, args.ImportID)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if x.Status != StatusUndoing || x.Generation != args.Generation {
		return nil
	}
	var embeddings bool
	if err := s.d.DB.Pool.QueryRow(ctx, `SELECT to_regclass('ai_embeddings') IS NOT NULL`).Scan(&embeddings); err != nil {
		return err
	}
	deadline := time.Now().Add(runBudget)
	for _, step := range undoSteps {
		for {
			if time.Now().After(deadline) {
				return river.JobSnooze(0)
			}
			n, err := s.undoBatch(ctx, &x, step.kind, step.remove, embeddings)
			if errors.Is(err, errStopped) {
				return nil
			}
			if err != nil {
				return err
			}
			if n < undoBatch {
				break
			}
		}
	}
	var file *string
	err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		cur, err := lockRow(ctx, tx, x.WorkspaceID, x.ID)
		if err != nil {
			return err
		}
		if cur.Status != StatusUndoing || cur.Generation != x.Generation {
			return errStopped
		}
		file = cur.StorageKey
		if _, err := tx.Exec(ctx, `DELETE FROM import_records WHERE import_id = $1`, x.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE imports SET status = 'undone', credentials_enc = NULL, storage_key = NULL, finished_at = now(),
			cursor = '{}', updated_at = now() WHERE id = $1`, x.ID); err != nil {
			return err
		}
		done, err := loadRow(ctx, tx, x.WorkspaceID, x.ID)
		if err != nil {
			return err
		}
		return publish(ctx, tx, "import.updated", done)
	})
	if errors.Is(err, errStopped) {
		return nil
	}
	if err == nil && file != nil {
		_ = s.d.Storage.Delete(context.WithoutCancel(ctx), *file)
	}
	return err
}

// undoBatch removes up to undoBatch rows of one kind that the import created, and
// forgets their records whether or not they could go (a contact with other tickets stays).
func (s *Service) undoBatch(ctx context.Context, x *row, kind, remove string, embeddings bool) (int, error) {
	var keys []string
	var n int
	err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		cur, err := lockRow(ctx, tx, x.WorkspaceID, x.ID)
		if err != nil {
			return err
		}
		if cur.Status != StatusUndoing || cur.Generation != x.Generation {
			return errStopped
		}
		ids, err := pgxCollect[uuid.UUID](tx.Query(ctx, `SELECT local_id FROM import_records WHERE import_id = $1 AND kind = $2 AND created
			ORDER BY local_id LIMIT $3`, x.ID, kind, undoBatch))
		if err != nil {
			return err
		}
		n = len(ids)
		if n == 0 {
			return nil
		}
		gone := ids
		if kind == "ticket" {
			// A ticket the team has written on since stays: it has a message no import wrote.
			// Its records are forgotten all the same, and what it uses stays with it.
			kept, err := pgxCollect[uuid.UUID](tx.Query(ctx, `SELECT DISTINCT m.ticket_id FROM messages m
				WHERE m.workspace_id = $1 AND m.ticket_id = ANY($2) AND NOT EXISTS (SELECT 1 FROM import_records r
					WHERE r.workspace_id = $1 AND r.kind = 'message' AND r.local_id = m.id)`, x.WorkspaceID, ids))
			if err != nil {
				return err
			}
			gone = slices.DeleteFunc(slices.Clone(ids), func(id uuid.UUID) bool { return slices.Contains(kept, id) })
			if keys, err = pgxCollect[string](tx.Query(ctx, `SELECT a.storage_key FROM attachments a JOIN messages m ON m.id = a.message_id
				WHERE a.workspace_id = $1 AND m.ticket_id = ANY($2)`, x.WorkspaceID, gone)); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM import_records WHERE import_id = $1 AND kind = 'message'
				AND local_id IN (SELECT id FROM messages WHERE workspace_id = $2 AND ticket_id = ANY($3))`, x.ID, x.WorkspaceID, ids); err != nil {
				return err
			}
		}
		if embeddings && (kind == "ticket" || kind == "article") {
			if _, err := tx.Exec(ctx, `DELETE FROM ai_embeddings WHERE workspace_id = $1 AND kind = $2 AND ref_id = ANY($3)`,
				x.WorkspaceID, kind, gone); err != nil {
				return err
			}
		}
		if kind == "article" {
			// The files of the articles that go pass to articles and entries that stay and show them.
			if err := hd.ReleaseFiles(ctx, tx, x.WorkspaceID, hd.ArticleFiles, gone, nil); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, remove, x.WorkspaceID, gone); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM import_records WHERE import_id = $1 AND kind = $2 AND local_id = ANY($3)`, x.ID, kind, ids)
		return err
	})
	if err != nil {
		return 0, err
	}
	for _, k := range keys {
		_ = s.d.Storage.Delete(context.WithoutCancel(ctx), k)
	}
	return n, nil
}

type sweepWorker struct {
	river.WorkerDefaults[jobs.ImportSweepArgs]
	s *Service
}

// credentialsKept is how long credentials stay after an import's last run.
const credentialsKept = 30 * 24 * time.Hour

// uploadKept is how long a CSV upload waits for its import to start.
const uploadKept = 24 * time.Hour

func (w *sweepWorker) Work(ctx context.Context, _ *river.Job[jobs.ImportSweepArgs]) error {
	return w.s.sweep(ctx)
}

// sweep removes credentials and CSV files that are no longer needed, and uploads that
// never became an import.
func (s *Service) sweep(ctx context.Context) error {
	cutoff := time.Now().Add(-credentialsKept)
	keys, err := pgxCollect[string](s.d.DB.Pool.Query(ctx, `UPDATE imports i SET credentials_enc = NULL, storage_key = NULL, updated_at = now()
		FROM (SELECT id, storage_key FROM imports WHERE status IN ('completed', 'failed', 'canceled', 'paused')
			AND (credentials_enc IS NOT NULL OR storage_key IS NOT NULL) AND COALESCE(finished_at, updated_at) < $1 FOR UPDATE) old
		WHERE i.id = old.id RETURNING COALESCE(old.storage_key, '')`, cutoff))
	if err != nil {
		return err
	}
	ups, err := pgxCollect[string](s.d.DB.Pool.Query(ctx, `DELETE FROM import_uploads WHERE created_at < $1 RETURNING storage_key`,
		time.Now().Add(-uploadKept)))
	if err != nil {
		return err
	}
	for _, k := range append(keys, ups...) {
		if k != "" {
			_ = s.d.Storage.Delete(ctx, k)
		}
	}
	return nil
}
