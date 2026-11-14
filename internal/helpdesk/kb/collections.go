package kb

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/deps"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/helpdesk/brands"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/ids"
)

type kbCollectionCreate struct {
	Name        string  `json:"name" minLength:"1" maxLength:"100"`
	Slug        string  `json:"slug,omitempty" maxLength:"100"`
	Description string  `json:"description,omitempty" maxLength:"1000"`
	Position    int     `json:"position,omitempty"`
	BrandID     *string `json:"brand_id,omitempty" required:"false" nullable:"true" doc:"Brand id, or null for every brand"`
}

type kbCollectionPatch struct {
	Name        *string             `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Slug        *string             `json:"slug,omitempty" maxLength:"100"`
	Description *string             `json:"description,omitempty" maxLength:"1000"`
	Position    *int                `json:"position,omitempty"`
	BrandID     hd.Nullable[string] `json:"brand_id,omitempty" doc:"Brand id, or null for every brand"`
}

// brandRef parses an optional brand id of the workspace; "" means every brand.
func brandRef(ctx context.Context, q db.Querier, wid uuid.UUID, raw string) (*uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	id, err := hd.ParseRef(raw, "brand_id")
	if err != nil {
		return nil, err
	}
	if err := brands.Check(ctx, q, wid, id); err != nil {
		return nil, err
	}
	return &id, nil
}

// brandFilter is the ?brand_id= filter of the agent lists: a brand id, or "none" for what
// every brand shows. col is the brand expression it applies to.
func brandFilter(raw, col string, arg func(any) string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "":
		return "", nil
	case "none":
		return col + " IS NULL", nil
	}
	id, err := hd.ParseRef(raw, "brand_id")
	if err != nil {
		return "", err
	}
	return col + " = " + arg(id), nil
}

type collectionOut struct{ Body KbCollection }

func cleanName(s string) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", httpx.Validation("name is required")
	}
	return hd.Truncate(s, 100), nil
}

// pickSlug returns a unique slug: the requested one (slugified, 409 when taken), or one
// generated from fallback.
func pickSlug(ctx context.Context, q db.Querier, table string, wid uuid.UUID, requested *string, fallback string, exclude *uuid.UUID) (string, error) {
	if requested != nil && strings.TrimSpace(*requested) != "" {
		slug := hd.Slugify(*requested)
		if slug == "" {
			return "", httpx.Validation("slug must contain letters or digits")
		}
		var taken bool
		if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM `+table+` WHERE workspace_id = $1 AND slug = $2 AND ($3::uuid IS NULL OR id <> $3))`,
			wid, slug, exclude).Scan(&taken); err != nil {
			return "", err
		}
		if taken {
			return "", httpx.Conflict("that slug is already in use")
		}
		return slug, nil
	}
	return hd.UniqueSlug(ctx, q, table, wid, hd.Slugify(fallback), exclude)
}

func slugConflict(err error) error {
	if db.IsUniqueViolation(err, "") {
		return httpx.Conflict("that slug is already in use")
	}
	return err
}

func registerCollections(d *deps.Deps, api huma.API) {
	huma.Register(api, huma.Operation{OperationID: "list-kb-collections", Method: http.MethodGet, Path: "/v1/kb/collections",
		Summary: "List knowledge base collections", Tags: []string{"Knowledge base"}},
		func(ctx context.Context, in *struct {
			BrandID string `query:"brand_id" doc:"Only this brand's collections; \"none\" for those of every brand"`
		}) (*struct{ Body httpx.Page[KbCollection] }, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeKBRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			args := []any{false, p.WorkspaceID}
			filter, err := brandFilter(in.BrandID, "k.brand_id", func(v any) string {
				args = append(args, v)
				return "$" + itoaArg(len(args))
			})
			if err != nil {
				return nil, err
			}
			if filter != "" {
				filter = " AND " + filter
			}
			rows, err := d.DB.Pool.Query(ctx, collectionSelect+` WHERE k.workspace_id = $2`+filter+` ORDER BY k.position, k.name, k.id`, args...)
			out, err := collectRows(rows, err, scanCollection)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &struct{ Body httpx.Page[KbCollection] }{httpx.Page[KbCollection]{Data: out}}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "get-kb-collection", Method: http.MethodGet, Path: "/v1/kb/collections/{id}",
		Summary: "Get a knowledge base collection", Tags: []string{"Knowledge base"}},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*collectionOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleViewer, auth.ScopeKBRead)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Collection")
			if err != nil {
				return nil, err
			}
			c, err := loadCollection(ctx, d.DB.Pool, p.WorkspaceID, id)
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("Collection")
			}
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &collectionOut{c}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "create-kb-collection", Method: http.MethodPost, Path: "/v1/kb/collections",
		Summary: "Create a knowledge base collection", Tags: []string{"Knowledge base"}, DefaultStatus: http.StatusCreated},
		func(ctx context.Context, in *struct{ Body kbCollectionCreate }) (*collectionOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeKBWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			name, err := cleanName(in.Body.Name)
			if err != nil {
				return nil, err
			}
			var c KbCollection
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				var brand *uuid.UUID
				if in.Body.BrandID != nil {
					if brand, err = brandRef(ctx, tx, p.WorkspaceID, *in.Body.BrandID); err != nil {
						return err
					}
				}
				slug, err := pickSlug(ctx, tx, "kb_collections", p.WorkspaceID, &in.Body.Slug, name, nil)
				if err != nil {
					return err
				}
				id := ids.New()
				if _, err := tx.Exec(ctx, `INSERT INTO kb_collections (id, workspace_id, name, slug, description, position, brand_id)
					VALUES ($1,$2,$3,$4,$5,$6,$7)`, id, p.WorkspaceID, name, slug, strings.TrimSpace(in.Body.Description), in.Body.Position, brand); err != nil {
					return slugConflict(err)
				}
				if c, err = loadCollection(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "kb_collection.created", Data: map[string]any{"kb_collection": c}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &collectionOut{c}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "update-kb-collection", Method: http.MethodPatch, Path: "/v1/kb/collections/{id}",
		Summary: "Update a knowledge base collection", Tags: []string{"Knowledge base"}},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body kbCollectionPatch
		}) (*collectionOut, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeKBWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Collection")
			if err != nil {
				return nil, err
			}
			var c KbCollection
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				cur, err := scanCollection(tx.QueryRow(ctx, collectionSelect+` WHERE k.workspace_id = $2 AND k.id = $3 FOR UPDATE OF k`, false, p.WorkspaceID, id))
				if db.IsNotFound(err) {
					return httpx.NotFound("Collection")
				}
				if err != nil {
					return err
				}
				b := in.Body
				if b.Name != nil {
					if cur.Name, err = cleanName(*b.Name); err != nil {
						return err
					}
				}
				oldSlug := cur.Slug
				if b.Slug != nil {
					if cur.Slug, err = pickSlug(ctx, tx, "kb_collections", p.WorkspaceID, b.Slug, cur.Name, &id); err != nil {
						return err
					}
				}
				if b.Description != nil {
					cur.Description = strings.TrimSpace(*b.Description)
				}
				if b.Position != nil {
					cur.Position = *b.Position
				}
				if b.BrandID.Set {
					cur.BrandID = nil
					if !b.BrandID.Null {
						if cur.BrandID, err = brandRef(ctx, tx, p.WorkspaceID, b.BrandID.Value); err != nil {
							return err
						}
					}
				}
				if _, err := tx.Exec(ctx, `UPDATE kb_collections SET name = $3, slug = $4, description = $5, position = $6, brand_id = $7, updated_at = now()
					WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id, cur.Name, cur.Slug, cur.Description, cur.Position, cur.BrandID); err != nil {
					return slugConflict(err)
				}
				// Its old address, and so its articles' (/c/<old>/<slug>), leads to it now.
				if oldSlug != cur.Slug {
					if err := redirectCollection(ctx, tx, p.WorkspaceID, "/c/"+oldSlug, id); err != nil {
						return err
					}
				}
				if c, err = loadCollection(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "kb_collection.updated", Data: map[string]any{"kb_collection": c}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &collectionOut{c}, nil
		})

	huma.Register(api, huma.Operation{OperationID: "delete-kb-collection", Method: http.MethodDelete, Path: "/v1/kb/collections/{id}",
		Summary: "Delete a knowledge base collection", Description: "Its articles stay, without a collection.",
		Tags: []string{"Knowledge base"}, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*hd.Empty, error) {
			p, err := auth.RequireWorkspace(ctx, auth.RoleAgent, auth.ScopeKBWrite)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := hd.ParseID(in.ID, "Collection")
			if err != nil {
				return nil, err
			}
			err = d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := releaseArticles(ctx, tx, p.WorkspaceID, id); err != nil {
					return err
				}
				tag, err := tx.Exec(ctx, `DELETE FROM kb_collections WHERE workspace_id = $1 AND id = $2`, p.WorkspaceID, id)
				if err != nil {
					return err
				}
				if tag.RowsAffected() == 0 {
					return httpx.NotFound("Collection")
				}
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: "kb_collection.deleted", Data: map[string]any{"kb_collection_id": id}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		})
}

// releaseArticles takes the articles out of a collection about to be deleted, one at a time:
// each keeps its slug where no article outside a collection has it, else takes a free one,
// and its old address (/c/<collection>/<slug>) leads to its new one.
func releaseArticles(ctx context.Context, tx pgx.Tx, wid, collection uuid.UUID) error {
	rows, err := tx.Query(ctx, `SELECT a.id, a.slug, k.slug FROM kb_articles a JOIN kb_collections k ON k.id = a.collection_id
		WHERE a.workspace_id = $1 AND a.collection_id = $2 ORDER BY a.created_at, a.id FOR UPDATE OF a`, wid, collection)
	if err != nil {
		return err
	}
	type moving struct {
		id               uuid.UUID
		slug, collection string
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (moving, error) {
		var m moving
		return m, r.Scan(&m.id, &m.slug, &m.collection)
	})
	if err != nil {
		return err
	}
	for _, m := range list {
		slug, err := freeArticleSlug(ctx, tx, wid, nil, m.slug, &m.id)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE kb_articles SET collection_id = NULL, slug = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
			wid, m.id, slug); err != nil {
			return err
		}
		if err := redirectArticle(ctx, tx, wid, articlePathOf(m.collection, m.slug), m.id); err != nil {
			return err
		}
	}
	return nil
}
