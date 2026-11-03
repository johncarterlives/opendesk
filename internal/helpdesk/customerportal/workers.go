package customerportal

import (
	"context"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/crypto"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/emails"
	"github.com/useopendesk/opendesk/internal/ids"
	"github.com/useopendesk/opendesk/internal/jobs"
)

// RegisterWorkers adds customer password-link and expired-credential workers.
func RegisterWorkers(d *deps.Deps, w *river.Workers) {
	river.AddWorker(w, &forgotWorker{d: d})
	river.AddWorker(w, &cleanupWorker{d: d})
}

// Periodic prunes expired customer sessions and reset links daily.
func Periodic(_ *deps.Deps) []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(24*time.Hour), func() (river.JobArgs, *river.InsertOpts) {
			return jobs.CustomerPortalCleanupArgs{}, nil
		}, &river.PeriodicJobOpts{RunOnStart: true}),
	}
}

type forgotWorker struct {
	river.WorkerDefaults[jobs.CustomerPortalForgotArgs]
	d *deps.Deps
}

func (w *forgotWorker) Work(ctx context.Context, job *river.Job[jobs.CustomerPortalForgotArgs]) error {
	a := job.Args
	hc, err := helpCenter(ctx, w.d, a.Slug)
	if err != nil {
		// A help center may be turned off between the request and delivery.
		if db.IsNotFound(err) {
			return nil
		}
		if he, ok := err.(interface{ GetStatus() int }); ok && he.GetStatus() == 404 {
			return nil
		}
		return err
	}
	if hc.WorkspaceID != a.WorkspaceID {
		return nil
	}
	return w.d.DB.Tx(ctx, func(tx pgx.Tx) error {
		var cid uuid.UUID
		var email string
		err := tx.QueryRow(ctx, `SELECT id,email FROM contacts WHERE workspace_id=$1 AND email=$2 AND NOT blocked FOR UPDATE`, a.WorkspaceID, a.Email).Scan(&cid, &email)
		if db.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		var recent int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM customer_password_resets WHERE workspace_id=$1 AND contact_id=$2 AND created_at>now()-interval '1 hour'`, a.WorkspaceID, cid).Scan(&recent); err != nil {
			return err
		}
		if recent >= 5 {
			return nil
		}
		token := crypto.RandomToken(32)
		if _, err := tx.Exec(ctx, `INSERT INTO customer_password_resets(id,workspace_id,contact_id,email,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, ids.New(), a.WorkspaceID, cid, email, crypto.HashToken(token), time.Now().Add(resetTTL)); err != nil {
			return err
		}
		site := emails.SiteFrom(w.d.Cfg)
		link := site.App("/portal/"+url.PathEscape(hc.Slug)+"/reset") + "#token=" + url.QueryEscape(token)
		return enqueueMail(ctx, w.d, tx, email, emails.CustomerPortalReset(site, hc.Title, link))
	})
}

type cleanupWorker struct {
	river.WorkerDefaults[jobs.CustomerPortalCleanupArgs]
	d *deps.Deps
}

func (w *cleanupWorker) Work(ctx context.Context, _ *river.Job[jobs.CustomerPortalCleanupArgs]) error {
	for _, query := range []string{
		`DELETE FROM customer_password_resets WHERE expires_at<now()-interval '1 day'`,
		`DELETE FROM customer_sessions WHERE expires_at<now()-interval '30 days' OR revoked_at<now()-interval '30 days'`,
	} {
		if _, err := w.d.DB.Pool.Exec(ctx, query); err != nil {
			return err
		}
	}
	return nil
}
