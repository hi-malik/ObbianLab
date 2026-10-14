package allocation

import (
	"sort"
	"time"
)

type Candidate struct {
	ID             string
	DistanceMetres int
	Rating         float64
	IdleSince      time.Time
}

// RankCandidates deliberately keeps the scoring explainable. Distance is the
// dominant signal; rating breaks close calls and idle time prevents starvation.
func RankCandidates(candidates []Candidate, now time.Time) []Candidate {
	ranked := append([]Candidate(nil), candidates...)
	sort.SliceStable(ranked, func(i, j int) bool {
		return score(ranked[i], now) < score(ranked[j], now)
	})
	return ranked
}

func score(candidate Candidate, now time.Time) float64 {
	idleMinutes := now.Sub(candidate.IdleSince).Minutes()
	if idleMinutes < 0 {
		idleMinutes = 0
	}
	if idleMinutes > 120 {
		idleMinutes = 120
	}
	return float64(candidate.DistanceMetres) - candidate.Rating*80 - idleMinutes*2
}
