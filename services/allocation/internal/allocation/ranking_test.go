package allocation

import (
	"testing"
	"time"
)

func TestRankCandidatesDoesNotMutateInput(t *testing.T) {
	now := time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC)
	input := []Candidate{
		{ID: "far", DistanceMetres: 1500, Rating: 5, IdleSince: now.Add(-time.Hour)},
		{ID: "near", DistanceMetres: 400, Rating: 4, IdleSince: now.Add(-time.Minute)},
	}

	ranked := RankCandidates(input, now)
	if ranked[0].ID != "near" {
		t.Fatalf("expected near candidate first, got %s", ranked[0].ID)
	}
	if input[0].ID != "far" {
		t.Fatal("ranker mutated its input")
	}
}

func TestLongIdleTimeIsBounded(t *testing.T) {
	now := time.Now()
	old := Candidate{ID: "old", DistanceMetres: 1000, Rating: 4, IdleSince: now.Add(-24 * time.Hour)}
	twoHours := Candidate{ID: "two-hours", DistanceMetres: 1000, Rating: 4, IdleSince: now.Add(-2 * time.Hour)}
	if score(old, now) != score(twoHours, now) {
		t.Fatal("idle bonus should be capped to avoid gaming stale presence")
	}
}
