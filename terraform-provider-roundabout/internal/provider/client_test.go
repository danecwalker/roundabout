package provider

import (
	"context"
	"testing"
)

func TestClientCRUD(t *testing.T) {
	ctx := context.Background()
	_, srv := newFakeAPI(t)
	c := NewClient(srv.URL+"/", testAPIKey, nil)

	site, secret, err := c.CreateSite(ctx, SiteInput{Name: "Shop", Domains: []string{"shop.example.com"}, Mode: "managed", Difficulty: 16})
	if err != nil {
		t.Fatal(err)
	}
	if site.ID == "" || secret == "" {
		t.Fatalf("expected id and secret, got %+v %q", site, secret)
	}

	got, err := c.GetSite(ctx, site.ID)
	if err != nil || got.Name != "Shop" {
		t.Fatalf("get: %+v %v", got, err)
	}

	name := "Shop 2"
	upd, err := c.UpdateSite(ctx, site.ID, SiteUpdate{Name: &name})
	if err != nil || upd.Name != "Shop 2" || upd.Difficulty != 16 {
		t.Fatalf("update: %+v %v", upd, err)
	}

	rot, err := c.RotateSecret(ctx, site.ID, 12)
	if err != nil || rot.Secret == secret || rot.PreviousSecretExpiresAt == nil {
		t.Fatalf("rotate: %+v %v", rot, err)
	}

	list, err := c.ListSites(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %+v %v", list, err)
	}

	// DELETE must carry a JSON body or the fake (like the real API) returns 415.
	if err := c.DeleteSite(ctx, site.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := c.GetSite(ctx, site.ID); !IsNotFound(err) {
		t.Fatalf("expected not found after delete, got %v", err)
	}
}

func TestClientErrors(t *testing.T) {
	ctx := context.Background()
	_, srv := newFakeAPI(t)

	_, err := NewClient(srv.URL, "rbk_wrong", nil).ListSites(ctx)
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != 401 || apiErr.Message != "unauthorized" {
		t.Fatalf("expected 401 APIError, got %#v", err)
	}

	_, _, err = NewClient(srv.URL, testAPIKey, nil).CreateSite(ctx, SiteInput{Name: "x"})
	if err == nil || err.Error() != "roundabout API error (HTTP 400): add at least one domain" {
		t.Fatalf("expected server message, got %v", err)
	}
}
