// Package customerportal serves contact identities and their own support requests.
package customerportal

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/kb"
	"github.com/useopendesk/opendesk/internal/httpx"
)

type brandConfig struct {
	Title       string        `json:"title"`
	LogoURL     domain.Avatar `json:"logo_url"`
	Color       string        `json:"color"`
	Locale      string        `json:"locale"`
	LocaleFixed bool          `json:"locale_fixed"`
	HelpURL     string        `json:"help_url"`
}

func helpCenter(ctx context.Context, d *deps.Deps, slug string) (kb.HelpCenter, error) {
	hc, err := kb.HelpCenterBySlug(ctx, d.DB.Pool, slug)
	if db.IsNotFound(err) || (err == nil && !hc.Enabled) {
		return hc, httpx.NotFound("Help center")
	}
	return hc, httpx.Wrap(err)
}

// Register adds the portal's public configuration and separate customer authentication.
func Register(d *deps.Deps, api huma.API, _ chi.Router) {
	s := &service{d: d}
	op := s.operation("customer-portal-config", http.MethodGet, "/v1/public/help/{workspace_slug}/portal/config", "Customer portal brand", true)
	huma.Register(api, op, func(ctx context.Context, in *struct {
		Slug string `path:"workspace_slug"`
	}) (*struct{ Body brandConfig }, error) {
		hc, err := helpCenter(ctx, d, in.Slug)
		if err != nil {
			return nil, err
		}
		helpURL := d.Cfg.HelpCenterURL(hc.Slug)
		if hc.ActiveHost != "" {
			helpURL = "https://" + hc.ActiveHost
		}
		return &struct{ Body brandConfig }{brandConfig{hc.Title, hc.Logo, hc.Color, hc.Locale, hc.LocaleFixed, helpURL}}, nil
	})
	s.registerAuth(api)
	s.registerTickets(api)
}
