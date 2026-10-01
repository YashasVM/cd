package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

const (
	progressBarWidth = 24
	progressInterval = 100 * time.Millisecond
	// The rate is smoothed over recent samples so the speed and ETA don't
	// jitter with every acknowledgement.
	progressRateSmoothing = 0.3
)

// progressBar draws one self-overwriting status line on a terminal:
//
//	sending [██████████░░░░░░░░░░░░░░]  42%  14.2 MiB / 34.0 MiB  5.1 MiB/s  ETA 0:04
type progressBar struct {
	out   io.Writer
	label string
	total uint64

	started   time.Time
	drawnAt   time.Time
	sampledAt time.Time
	sampled   uint64
	rate      float64 // bytes per second
	drawn     bool
	// jsonLines writes one {"progress":…} object per line instead of a bar,
	// for agents that read stderr from a pipe.
	jsonLines bool
}

// jsonProgressInterval keeps machine-readable progress to about one line a second.
const jsonProgressInterval = time.Second

type progressLine struct {
	Progress struct {
		Phase string  `json:"phase"`
		Done  uint64  `json:"done"`
		Total uint64  `json:"total"`
		Rate  uint64  `json:"bytesPerSecond"`
		ETA   float64 `json:"etaSeconds,omitempty"`
	} `json:"progress"`
}

func newProgressBar(out io.Writer, label string, total uint64) *progressBar {
	now := time.Now()
	return &progressBar{out: out, label: label, total: total, started: now, sampledAt: now}
}

// update redraws the line at most every progressInterval, and always for
// the final byte.
func (p *progressBar) update(done uint64) {
	p.updateAt(done, time.Now())
}

func (p *progressBar) updateAt(done uint64, now time.Time) {
	if p.total == 0 {
		return
	}
	if elapsed := now.Sub(p.sampledAt).Seconds(); elapsed >= 0.25 && done >= p.sampled {
		instant := float64(done-p.sampled) / elapsed
		if p.rate == 0 {
			p.rate = instant
		} else {
			p.rate = progressRateSmoothing*instant + (1-progressRateSmoothing)*p.rate
		}
		p.sampledAt, p.sampled = now, done
	}
	interval := progressInterval
	if p.jsonLines {
		interval = jsonProgressInterval
	}
	if p.drawn && done < p.total && now.Sub(p.drawnAt) < interval {
		return
	}
	p.drawnAt = now
	p.drawn = true
	if p.jsonLines {
		var line progressLine
		line.Progress.Phase, line.Progress.Done, line.Progress.Total = p.label, done, p.total
		line.Progress.Rate = uint64(p.rate)
		if p.rate > 0 && done < p.total {
			line.Progress.ETA = float64(int(float64(p.total-done)/p.rate*10)) / 10
		}
		_ = json.NewEncoder(p.out).Encode(line)
		return
	}
	fmt.Fprintf(p.out, "\r%s\x1b[K", p.line(done, now))
}

func (p *progressBar) line(done uint64, now time.Time) string {
	if done > p.total {
		done = p.total
	}
	fraction := float64(done) / float64(p.total)
	filled := int(fraction * progressBarWidth)
	bar := strings.Repeat("█", filled) + strings.Repeat("░", progressBarWidth-filled)
	line := fmt.Sprintf("%s [%s] %3d%%  %s / %s", p.label, bar, int(fraction*100), formatShortBytes(done), formatShortBytes(p.total))
	if done == p.total {
		elapsed := now.Sub(p.started)
		if seconds := elapsed.Seconds(); seconds > 0 {
			line += fmt.Sprintf("  %s/s  in %s", formatShortBytes(uint64(float64(p.total)/seconds)), formatETA(elapsed))
		}
		return line
	}
	if p.rate > 0 {
		remaining := time.Duration(float64(p.total-done) / p.rate * float64(time.Second))
		line += fmt.Sprintf("  %s/s  ETA %s", formatShortBytes(uint64(p.rate)), formatETA(remaining))
	}
	return line
}

// finish ends the line so later output starts on a fresh one.
func (p *progressBar) finish() {
	if p.drawn && !p.jsonLines {
		fmt.Fprintln(p.out)
		p.drawn = false
	}
}

func formatETA(d time.Duration) string {
	seconds := int(d.Round(time.Second).Seconds())
	if seconds >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", seconds/3600, seconds/60%60, seconds%60)
	}
	return fmt.Sprintf("%d:%02d", seconds/60, seconds%60)
}
