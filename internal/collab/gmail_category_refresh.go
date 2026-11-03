package collab

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// gmailCategoryRefresh persists a stable stored-message keyset and a baseline to replay.
type gmailCategoryRefresh struct {
	Baseline string    `json:"baseline"`
	From     string    `json:"from"`
	Expired  bool      `json:"expired"`
	Listed   bool      `json:"listed"`
	Backlog  []string  `json:"backlog,omitempty"`
	Cursor   uuid.UUID `json:"cursor"`
	Swept    bool      `json:"swept"`
	Page     string    `json:"page"`
	Run      string    `json:"run"`
}

func (s *service) saveCategoryRefresh(ctx context.Context, tx pgx.Tx, a *accountRow, r *gmailCategoryRefresh) error {
	var value any
	if r != nil {
		b, err := json.Marshal(r)
		if err != nil {
			return err
		}
		value = b
	}
	_, err := tx.Exec(ctx, `UPDATE collab_accounts SET category_refresh = $3 WHERE id = $1 AND category_epoch = $2 AND category_engine = 'gmail'`, a.ID, a.CategoryEpoch, value)
	return err
}

// A sweep commits observations with its keyset cursor. Only replay completion replaces
// the live history cursor, so interruption never loses changes made during the sweep.
func (s *service) refreshGmailCategories(ctx context.Context, p *pass, g *gmailProvider) (bool, error) {
	var raw []byte
	if err := s.d.DB.Pool.QueryRow(ctx, `SELECT category_refresh FROM collab_accounts WHERE id = $1`, p.a.ID).Scan(&raw); err != nil {
		return false, err
	}
	if raw == nil {
		return false, nil
	}
	expectedAccount := copyAccount(p.a)
	expectedEpoch := expectedAccount.CategoryEpoch
	var r gmailCategoryRefresh
	if err := json.Unmarshal(raw, &r); err != nil {
		return true, err
	}
	if r.Baseline == "" {
		baseline, err := g.profileHistoryID(ctx)
		if err != nil {
			return true, err
		}
		r.Baseline, r.From = baseline, baseline
		var live gmailSyncState
		_ = json.Unmarshal(p.a.SyncState, &live)
		if !r.Expired && live.HistoryID != "" {
			r.From = live.HistoryID
		}
		r.Backlog = live.Backlog
		if err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error { return s.saveCategoryRefresh(ctx, tx, expectedAccount, &r) }); err != nil {
			return true, err
		}
	}
	if !r.Listed {
		backlog, err := s.importGmailWindow(ctx, p, g, r.Backlog)
		if err != nil {
			return true, err
		}
		if p.a.CategoryEpoch != expectedEpoch {
			return true, nil
		}
		r.Backlog, r.Listed = backlog, true
		if err := s.d.DB.Tx(ctx, func(tx pgx.Tx) error { return s.saveCategoryRefresh(ctx, tx, expectedAccount, &r) }); err != nil {
			return true, err
		}
	}

	if !r.Swept {
		rows, err := s.d.DB.Pool.Query(ctx, `SELECT id,remote_id FROM collab_messages WHERE workspace_id = $1 AND account_id = $2 AND id > $3 ORDER BY id LIMIT 100`, p.a.WorkspaceID, p.a.ID, r.Cursor)
		if err != nil {
			return true, err
		}
		type item struct {
			id     uuid.UUID
			remote string
		}
		list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (item, error) { var i item; return i, row.Scan(&i.id, &i.remote) })
		if err != nil {
			return true, err
		}
		ids := []string{}
		for _, i := range list {
			ids = append(ids, i.remote)
		}
		res, errs := fetchEach(ctx, gmailFetchers, ids, g.fork, func(ctx context.Context, g *gmailProvider, id string) (*gmailMessage, error) {
			var m gmailMessage
			err := g.do(ctx, http.MethodGet, "/messages/"+url.PathEscape(id)+"?format=minimal", nil, &m)
			return &m, err
		})
		for _, err := range errs {
			if err != nil && !isNotFound(err) {
				return true, err
			}
		}
		if len(list) > 0 {
			r.Cursor = list[len(list)-1].id
		}
		r.Swept = len(list) < 100
		err = p.batch(ctx, func(tx pgx.Tx) error {
			if p.a.CategoryEpoch != expectedEpoch || p.a.CategoryEngine != modeGmail {
				return nil
			}
			for j, i := range list {
				m, err := p.lookup(ctx, tx, i.remote)
				if err != nil {
					return err
				}
				if m == nil {
					continue
				}
				if isNotFound(errs[j]) {
					if err := p.remove(ctx, tx, m); err != nil {
						return err
					}
					continue
				}
				ob, err := gmailObservation(res[j])
				if err != nil {
					return err
				}
				st := p.gmailState(res[j].LabelIDs)
				st.Gmail = ob
				if err := p.update(ctx, tx, m, st); err != nil {
					return err
				}
			}
			return s.saveCategoryRefresh(ctx, tx, expectedAccount, &r)
		})
		if err != nil || !r.Swept {
			return true, err
		}
		if p.a.CategoryEpoch != expectedEpoch {
			return true, nil
		}
	}
	changes, first, next, err := g.history(ctx, r.From, r.Page)
	if err == errHistoryGone || (err != nil && r.Page != "" && gmailRefused(err)) {
		// Start a new complete sweep when the baseline expires; never promote it.
		empty := &gmailCategoryRefresh{Expired: true}
		err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error { return s.saveCategoryRefresh(ctx, tx, expectedAccount, empty) })
		return true, err
	}
	if err != nil {
		return true, err
	}
	var live gmailSyncState
	_ = json.Unmarshal(p.a.SyncState, &live)
	backlog, err := s.applyGmailChanges(ctx, p, g, changes, r.Backlog)
	if err != nil {
		return true, err
	}
	if p.a.CategoryEpoch != expectedEpoch {
		return true, nil
	}
	r.Backlog = backlog
	if r.Run == "" {
		r.Run = first
	}
	r.Page = next
	if next != "" {
		return true, s.d.DB.Tx(ctx, func(tx pgx.Tx) error { return s.saveCategoryRefresh(ctx, tx, expectedAccount, &r) })
	}
	live.HistoryID, live.PageToken, live.RunHistoryID, live.Backlog = r.Run, "", "", backlog
	b, err := json.Marshal(live)
	if err != nil {
		return true, err
	}
	completed := false
	err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		a, err := loadAccountForUpdate(ctx, tx, p.a.ID)
		if err != nil {
			return err
		}
		if a.CategoryEpoch != expectedEpoch || a.CategoryEngine != modeGmail {
			return nil
		}
		if _, err := tx.Exec(ctx, `UPDATE collab_accounts SET sync_state = $2, category_refresh = NULL WHERE id = $1`, a.ID, b); err != nil {
			return err
		}
		completed = true
		return s.publishAccounts(ctx, tx, a.WorkspaceID, a.ID, nil)
	})
	if completed {
		p.a.SyncState = b
	}
	return !completed, err
}
