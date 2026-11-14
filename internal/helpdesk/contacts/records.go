package contacts

import (
	"context"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// fieldParams reads field.<key> filters from the query (see hd.FieldFiltersFromQuery).
type fieldParams struct {
	fields    []hd.FieldFilter
	fieldsErr error
}

func (f *fieldParams) Resolve(ctx huma.Context) []error {
	u := ctx.URL()
	f.fields, f.fieldsErr = hd.FieldFiltersFromQuery(u.Query())
	return nil
}

type contactListIn struct {
	httpx.ListParams
	Q         string `query:"q" maxLength:"200" doc:"Search name, email, phone and custom field values"`
	CompanyID string `query:"company_id" doc:"Only contacts of this company; none for those without one"`
	Tag       string `query:"tag" maxLength:"50" doc:"Label name"`
	Blocked   string `query:"blocked" enum:"true,false," doc:"Only blocked contacts, or only those who are not"`
	Sort      string `query:"sort" enum:"-created,created,name,-name,-tickets,tickets,-updated,updated," doc:"Newest first by default"`
	fieldParams
}

type companyListIn struct {
	httpx.ListParams
	Q    string `query:"q" maxLength:"200" doc:"Search name, domain and custom field values"`
	Tag  string `query:"tag" maxLength:"50" doc:"Label name"`
	Sort string `query:"sort" enum:"name,-name,-created,created,-contacts,contacts,-updated,updated," doc:"By name, A to Z, by default"`
	fieldParams
}

// contactFilter is the People list's filters: the list's query parameters, and the `query` of a
// bulk request, which acts on exactly what the list shows for them.
type contactFilter struct {
	Q         string           `json:"q,omitempty" maxLength:"200"`
	CompanyID string           `json:"company_id,omitempty" doc:"A company id, or none for people without one"`
	Tag       string           `json:"tag,omitempty" maxLength:"50"`
	Blocked   string           `json:"blocked,omitempty" enum:"true,false,"`
	Fields    []hd.FieldFilter `json:"fields,omitempty" maxItems:"20" doc:"Custom field filters, as the list's field.<key>[op]"`
}

// where is the filter's WHERE clause on contacts ct, from $1 (the workspace) on.
func (f contactFilter) where(ctx context.Context, q db.Querier, p *auth.Principal) (string, []any, error) {
	var companyID *uuid.UUID
	noCompany := f.CompanyID == "none"
	if f.CompanyID != "" && !noCompany {
		id, err := hd.ParseRef(f.CompanyID, "company_id")
		if err != nil {
			return "", nil, err
		}
		companyID = &id
	}
	text := strings.TrimSpace(f.Q)
	args := []any{p.WorkspaceID, text, likePrefix(text), companyID}
	extra, more, err := recordFilters(ctx, q, p, domain.ContactLabels, domain.FieldEntityContact, "ct", f.Tag, f.Fields, len(args))
	if err != nil {
		return "", nil, err
	}
	if noCompany {
		extra += " AND ct.company_id IS NULL"
	}
	switch f.Blocked {
	case "true":
		extra += " AND ct.blocked"
	case "false":
		extra += " AND NOT ct.blocked"
	}
	return ` WHERE ct.workspace_id = $1
		AND ($2 = '' OR ct.search @@ websearch_to_tsquery('simple', $2) OR ct.fields_search @@ websearch_to_tsquery('simple', $2)
			OR ct.email::text ILIKE $3 OR ct.name ILIKE $3 OR ` + domain.ExtraEmailLikeSQL("lower($3)") + `)
		AND ($4::uuid IS NULL OR ct.company_id = $4)` + extra, append(args, more...), nil
}

// companyFilter is the Companies list's filters, as contactFilter.
type companyFilter struct {
	Q      string           `json:"q,omitempty" maxLength:"200"`
	Tag    string           `json:"tag,omitempty" maxLength:"50"`
	Fields []hd.FieldFilter `json:"fields,omitempty" maxItems:"20" doc:"Custom field filters, as the list's field.<key>[op]"`
}

// where is the filter's WHERE clause on companies co, from $1 (the workspace) on.
func (f companyFilter) where(ctx context.Context, q db.Querier, p *auth.Principal) (string, []any, error) {
	text := strings.TrimSpace(f.Q)
	args := []any{p.WorkspaceID, text, "%" + strings.TrimSuffix(likePrefix(text), "%") + "%"}
	extra, more, err := recordFilters(ctx, q, p, domain.CompanyLabels, domain.FieldEntityCompany, "co", f.Tag, f.Fields, len(args))
	if err != nil {
		return "", nil, err
	}
	return ` WHERE co.workspace_id = $1
		AND ($2 = '' OR co.name ILIKE $3 OR co.domain::text ILIKE $3 OR co.fields_search @@ websearch_to_tsquery('simple', $2))` + extra, append(args, more...), nil
}

// recordFilters builds the extra " AND ..." clauses for label and custom field filters on
// alias, binding parameters from $next.
func recordFilters(ctx context.Context, q db.Querier, p *auth.Principal, kind domain.LabelKind, entity, alias, tag string,
	ff []hd.FieldFilter, last int) (string, []any, error) {
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(last+len(args))
	}
	sql := ""
	if tag != "" {
		sql += ` AND EXISTS (SELECT 1 FROM ` + kind.Table + ` flt JOIN tags fg ON fg.id = flt.tag_id
			WHERE flt.` + kind.Col + ` = ` + alias + `.id AND fg.workspace_id = ` + alias + `.workspace_id AND lower(fg.name) = lower(` + arg(tag) + `))`
	}
	if len(ff) > 0 {
		defs, err := domain.LoadFieldDefs(ctx, q, p.WorkspaceID, entity)
		if err != nil {
			return "", nil, err
		}
		norm, err := hd.NormalizeFieldFilters(defs, ff)
		if err != nil {
			return "", nil, err
		}
		for _, f := range norm {
			sql += " AND " + hd.FieldClause(defs[f.Key], f, alias+".fields", arg, p.ActorUserID())
		}
	}
	return sql, args, nil
}

// applyFields merges a fields patch into *cur after validating it against the entity's definitions.
func applyFields(ctx context.Context, tx pgx.Tx, wid uuid.UUID, entity string, cur *map[string]any, patch map[string]any) error {
	if *cur == nil {
		*cur = map[string]any{}
	}
	if patch == nil {
		return nil
	}
	defs, err := domain.LoadFieldDefs(ctx, tx, wid, entity)
	if err != nil {
		return err
	}
	next, _, err := domain.MergeFields(defs, *cur, patch, domain.MemberChecker(ctx, tx, wid))
	if err != nil {
		return err
	}
	*cur = next
	return nil
}

// applyLabels applies label changes by name to a contact or company.
func applyLabels(ctx context.Context, tx pgx.Tx, p *auth.Principal, kind domain.LabelKind, id uuid.UUID, replace *[]string, add, remove []string) error {
	ops := domain.TagOps{Replace: replace, Add: add, Remove: remove}
	if ops.Empty() {
		return nil
	}
	create, err := hd.CanCreateLabels(ctx, tx, p)
	if err != nil {
		return err
	}
	ops.Create = create
	_, _, err = domain.ApplyTags(ctx, tx, p.WorkspaceID, kind, id, ops)
	return err
}
