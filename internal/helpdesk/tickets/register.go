// Package tickets is the ticket side of the helpdesk: tickets, messages, activities,
// the ticket trigger worker (SLA, automations, round-robin, notifications), the
// periodic jobs, CSAT, global search and reports.
package tickets

import (
	"context"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/riverqueue/river"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Register adds this package's routes.
func Register(d *deps.Deps, api huma.API, r chi.Router) {
	// Every route tagged Tickets or Reports answers feature_disabled while the workspace has Tickets off.
	api.UseMiddleware(httpx.TicketsGate(d.DB.Pool, func(op *huma.Operation) bool { return httpx.HasTag(op, "Tickets") || httpx.HasTag(op, "Reports") }))
	registerChatAssigner(d)
	registerTickets(d, api)
	registerTrash(d, api)
	registerMessages(d, api)
	registerDrafts(d, api)
	registerReplyDrafts(d, api)
	registerTyping(d, api)
	registerVisitorPresence(d, api)
	registerThreads(d, api)
	registerTemplates(d, api)
	registerCSAT(d, api)
	registerInsights(d, api)
	registerAgentsReport(d, api)
	// The overview's ticket counts are the counts route's own answer for that workspace.
	d.Overview.TicketCounts = func(ctx context.Context, p *auth.Principal) (any, error) {
		return ticketCounts(ctx, d.DB.Pool, p)
	}
}

// RegisterWorkers adds the ticket trigger and periodic workers.
func RegisterWorkers(d *deps.Deps, w *river.Workers) {
	registerChatAssigner(d) // the answer bot hands over in workers too
	river.AddWorker(w, &TriggerWorker{D: d})
	river.AddWorker(w, &SLAScanWorker{D: d})
	river.AddWorker(w, &SnoozeWakeWorker{D: d})
	river.AddWorker(w, &AutoCloseWorker{D: d})
	river.AddWorker(w, &PurgeAttachmentsWorker{D: d})
}

// Periodic returns the scheduled helpdesk jobs.
func Periodic(d *deps.Deps) []*river.PeriodicJob { return periodicJobs() }
