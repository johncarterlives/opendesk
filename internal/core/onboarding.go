package core

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/ai/agentsetup"
	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/collab"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/products"
)

// OnboardingStep is one item of the setup checklist.
type OnboardingStep struct {
	ID          string `json:"id" enum:"connect_mailbox,invite_teammate,upload_photo,install_widget,publish_article,setup_triage,create_label,try_ollie,setup_ai_agent,connect_mail_account,share_mail_account"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Done        bool   `json:"done"`
	Href        string `json:"href" doc:"App path that completes the step"`
	Requires    string `json:"requires" enum:"admin,agent"`
}

// Onboarding is the setup checklist of the current workspace for the caller.
type Onboarding struct {
	Steps     []OnboardingStep `json:"steps"`
	DoneCount int              `json:"done_count"`
	Total     int              `json:"total"`
	Dismissed bool             `json:"dismissed"`
}

// seededLabels are the labels every new workspace starts with (createWorkspace).
var seededLabels = []string{"question", "problem", "bug", "feature request", "billing", "vip", "feedback"}

// loadOnboarding computes every step from the workspace's real state. instanceAI
// reports an AI provider on the instance (the AI agent step's checklist needs it).
// The steps follow the products that are on: with Tickets on they are the help desk's;
// with Tickets off they are Mail's (when Mail is on) and the team's. The Mail steps count only
// accounts the member sees (contracts/collab.md "Who sees what").
func loadOnboarding(ctx context.Context, q db.Querier, wid, uid uuid.UUID, instanceAI bool, on products.State) (Onboarding, error) {
	var mailbox, teammate, photo, widget, article, triage, label, ollie, mailAccount, mailShared, dismissed bool
	err := q.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM mailboxes WHERE workspace_id = $1),
		(SELECT count(*) FROM members WHERE workspace_id = $1) > 1
			OR EXISTS (SELECT 1 FROM invitations WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now()),
		EXISTS (SELECT 1 FROM users WHERE id = $2 AND avatar_url <> ''),
		w.widget_seen_at IS NOT NULL OR EXISTS (SELECT 1 FROM widgets WHERE workspace_id = $1 AND seen_at IS NOT NULL),
		EXISTS (SELECT 1 FROM kb_articles WHERE workspace_id = $1 AND status = 'published'),
		COALESCE(w.settings ->> 'auto_assign', 'none') <> 'none'
			OR EXISTS (SELECT 1 FROM assignment_rules WHERE workspace_id = $1 AND mode <> 'none')
			OR COALESCE(w.settings -> 'ai' ->> 'auto_triage', 'false') = 'true',
		EXISTS (SELECT 1 FROM tags WHERE workspace_id = $1 AND lower(name) <> ALL($3)),
		EXISTS (SELECT 1 FROM ai_usage WHERE workspace_id = $1 AND user_id IS NOT NULL),
		EXISTS (SELECT 1 FROM collab_accounts a WHERE a.workspace_id = $1 AND `+collab.AccountVisibleSQL("a", "$2")+`),
		EXISTS (SELECT 1 FROM collab_accounts a WHERE a.workspace_id = $1 AND a.visibility = 'shared' AND `+collab.AccountVisibleSQL("a", "$2")+`
			AND EXISTS (SELECT 1 FROM collab_shares sh WHERE sh.account_id = a.id)),
		COALESCE((SELECT onboarding_dismissed_at IS NOT NULL FROM members WHERE workspace_id = $1 AND user_id = $2), false)
		FROM workspaces w WHERE w.id = $1`, wid, uid, seededLabels).
		Scan(&mailbox, &teammate, &photo, &widget, &article, &triage, &label, &ollie, &mailAccount, &mailShared, &dismissed)
	if err != nil {
		return Onboarding{}, err
	}
	var steps []OnboardingStep
	if on.Tickets {
		agent, err := agentsetup.Load(ctx, q, wid, instanceAI)
		if err != nil {
			return Onboarding{}, err
		}
		steps = []OnboardingStep{
			{"connect_mailbox", "Connect a mailbox", "Bring your support email in so messages become tickets.", mailbox, "/settings/mailboxes", "admin"},
			{"invite_teammate", "Invite a teammate", "Answer tickets together and share the load.", teammate, "/settings/members", "admin"},
			{"upload_photo", "Upload your photo", "Customers and teammates see who is replying.", photo, "/settings/profile", "agent"},
			{"install_widget", "Install the chat widget", "Add live chat to your site with one script tag.", widget, "/settings/widget", "admin"},
			{"publish_article", "Publish a help article", "Answer common questions before they become tickets.", article, "/kb", "agent"},
			{"setup_triage", "Set up triage and assignment", "Let Ollie sort new tickets and route them to whoever is available.", triage, "/settings/triage", "admin"},
			{"create_label", "Create a label", "Group tickets by topic, product or customer type.", label, "/settings/tags", "admin"},
			{"try_ollie", "Try Ollie", "Ask Ollie to draft a reply, summarize a ticket or find an answer.", ollie, "/inbox/all", "agent"},
			{"setup_ai_agent", "Set up the AI agent", "Teach Ollie your answers, test it, then let it reply to chats.", agent.Complete, "/settings/ai/agent", "admin"},
		}
	} else {
		if on.Mail {
			steps = append(steps,
				OnboardingStep{"connect_mail_account", "Connect a mail account", "Bring a Gmail, Outlook or IMAP inbox in. Keep it private or share it.", mailAccount, "/settings/mail-accounts", "agent"},
				OnboardingStep{"share_mail_account", "Share an inbox with your team", "Everyone you add sees its mail and can reply, assign and comment.", mailShared, "/settings/mail-accounts", "agent"})
		}
		steps = append(steps,
			OnboardingStep{"invite_teammate", "Invite a teammate", "Work together and share the load.", teammate, "/settings/members", "admin"},
			OnboardingStep{"upload_photo", "Upload your photo", "Teammates see who is replying.", photo, "/settings/profile", "agent"})
	}
	o := Onboarding{Steps: steps, Total: len(steps), Dismissed: dismissed}
	for _, s := range steps {
		if s.Done {
			o.DoneCount++
		}
	}
	return o, nil
}

func (s *svc) registerOnboarding(api huma.API) {
	tags := []string{"Onboarding"}
	register(s, api, huma.Operation{OperationID: "get-onboarding", Method: http.MethodGet, Path: "/v1/onboarding",
		Summary: "Get the setup checklist", Tags: tags},
		func(ctx context.Context, _ *struct{}) (*struct{ Body Onboarding }, error) {
			p, err := requireUserWorkspace(ctx, auth.RoleViewer)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			on, err := products.Load(ctx, s.d.DB.Pool, s.d.Plan, s.d.Cfg.Collab, p.WorkspaceID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			o, err := loadOnboarding(ctx, s.d.DB.Pool, p.WorkspaceID, p.UserID, s.d.Cfg.AIEnabled(), on)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body Onboarding }{o}, nil
		})

	register(s, api, huma.Operation{OperationID: "dismiss-onboarding", Method: http.MethodPost, Path: "/v1/onboarding/dismiss",
		Summary: "Hide the setup checklist for yourself", Tags: tags, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			p, err := requireUserWorkspace(ctx, auth.RoleViewer)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if _, err := s.d.DB.Pool.Exec(ctx, `UPDATE members SET onboarding_dismissed_at = COALESCE(onboarding_dismissed_at, now())
				WHERE workspace_id = $1 AND user_id = $2`, p.WorkspaceID, p.UserID); err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}
