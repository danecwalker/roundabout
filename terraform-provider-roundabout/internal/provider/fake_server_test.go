package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testAPIKey = "rbk_test_key"

// fakeAPI is an in-memory implementation of the Roundabout admin site endpoints.
type fakeAPI struct {
	mu       sync.Mutex
	sites    map[string]*Site
	secrets  map[string]string
	seq      int
	rotateGH []int64 // grace_hours of each rotate call
}

func newFakeAPI(t *testing.T) (*fakeAPI, *httptest.Server) {
	t.Helper()
	f := &fakeAPI{sites: map[string]*Site{}, secrets: map[string]string{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+testAPIKey {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if r.Method != http.MethodGet && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeErr(w, http.StatusUnsupportedMediaType, "unsupported media type: expected application/json")
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()

	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/sites"), "/"), "/")
	id := parts[0]
	now := time.Now().UTC().Format(time.RFC3339)

	switch {
	case id == "" && r.Method == http.MethodGet:
		out := []Site{}
		for _, s := range f.sites {
			out = append(out, *s)
		}
		writeJSON(w, http.StatusOK, out)

	case id == "" && r.Method == http.MethodPost:
		var in SiteInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if len(in.Domains) == 0 {
			writeErr(w, http.StatusBadRequest, "add at least one domain")
			return
		}
		f.seq++
		s := &Site{
			ID: fmt.Sprintf("site-%d", f.seq), Name: in.Name, Sitekey: fmt.Sprintf("rk_%d", f.seq),
			Domains: in.Domains, Mode: in.Mode, Difficulty: in.Difficulty, CreatedAt: now, UpdatedAt: now,
			ClearanceEnabled: in.ClearanceEnabled, ClearanceTTLSecs: in.ClearanceTTLSecs,
		}
		if s.ClearanceTTLSecs == 0 {
			s.ClearanceTTLSecs = 1800
		}
		f.sites[s.ID] = s
		f.secrets[s.ID] = fmt.Sprintf("rs_secret_%d_0", f.seq)
		writeJSON(w, http.StatusCreated, map[string]any{"site": s, "secret": f.secrets[s.ID]})

	default:
		s, ok := f.sites[id]
		if !ok {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		switch {
		case len(parts) == 2 && parts[1] == "rotate-secret" && r.Method == http.MethodPost:
			var in struct {
				GraceHours int64 `json:"grace_hours"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			f.rotateGH = append(f.rotateGH, in.GraceHours)
			f.secrets[id] = fmt.Sprintf("rs_secret_%s_%d", id, len(f.rotateGH))
			exp := time.Now().Add(time.Duration(in.GraceHours) * time.Hour).UTC().Format(time.RFC3339)
			s.PreviousSecretExpiresAt = &exp
			writeJSON(w, http.StatusOK, RotatedSecret{Secret: f.secrets[id], PreviousSecretExpiresAt: &exp})
		case len(parts) == 1 && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, s)
		case len(parts) == 1 && r.Method == http.MethodPatch:
			var in SiteUpdate
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
				writeErr(w, http.StatusBadRequest, err.Error())
				return
			}
			if in.Name != nil {
				s.Name = *in.Name
			}
			if in.Domains != nil {
				s.Domains = in.Domains
			}
			if in.Mode != nil {
				s.Mode = *in.Mode
			}
			if in.Difficulty != nil {
				s.Difficulty = *in.Difficulty
			}
			if in.ClearanceEnabled != nil {
				s.ClearanceEnabled = *in.ClearanceEnabled
			}
			if in.ClearanceTTLSecs != nil {
				s.ClearanceTTLSecs = *in.ClearanceTTLSecs
			}
			s.UpdatedAt = now
			writeJSON(w, http.StatusOK, s)
		case len(parts) == 1 && r.Method == http.MethodDelete:
			delete(f.sites, id)
			w.WriteHeader(http.StatusNoContent)
		default:
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	}
}
