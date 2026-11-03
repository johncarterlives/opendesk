package auth

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCustomerPurposeAndPrincipalBoundary(t *testing.T) {
	tokens := NewTokens([]byte("test-only-customer-secret-0123456789"))
	token, _, err := tokens.Sign(Claims{Purpose: PurposeCustomerAccess, Workspace: uuid.NewString(), SessionID: uuid.NewString()}, uuid.NewString(), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for _, purpose := range []string{PurposeAccess, PurposeWS, PurposeWidgetWS, PurposeAdmin, PurposeMFA, PurposeMCPAccess} {
		if _, err := tokens.Verify(token, purpose); err == nil {
			t.Fatalf("customer token accepted as %s", purpose)
		}
	}
	for _, kind := range []Kind{KindUser, KindAPIKey, KindVisitor, KindCustomer} {
		p := &Principal{Kind: kind, WorkspaceID: uuid.New(), ContactID: uuid.New(), SessionID: uuid.New(), Role: RoleOwner, Scopes: AllScopes}
		ctx := WithPrincipal(context.Background(), p)
		_, err := RequireCustomer(ctx)
		if (kind == KindCustomer) != (err == nil) {
			t.Fatalf("customer gate: kind=%s err=%v", kind, err)
		}
		if kind == KindCustomer {
			if _, err := RequireWorkspace(ctx, RoleViewer, ScopeTicketsRead); err == nil {
				t.Fatal("customer passed workspace gate")
			}
			if _, err := RequireUser(ctx); err == nil {
				t.Fatal("customer passed user gate")
			}
			if _, err := RequireVisitor(ctx); err == nil {
				t.Fatal("customer passed visitor gate")
			}
		}
	}
}
