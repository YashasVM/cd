package main

import (
	"encoding/json"
	"os"
	"time"
)

type transferTiming struct {
	role  string
	start time.Time
}

func newTransferTiming(role string) *transferTiming {
	if os.Getenv("CD_TIMING_DEBUG") != "1" {
		return nil
	}
	return &transferTiming{role: role, start: time.Now()}
}

func (timing *transferTiming) mark(stage string) {
	if timing == nil {
		return
	}
	_ = json.NewEncoder(os.Stderr).Encode(struct {
		Event     string  `json:"event"`
		Role      string  `json:"role"`
		Stage     string  `json:"stage"`
		ElapsedMS float64 `json:"elapsedMs"`
	}{"transfer-timing", timing.role, stage, float64(time.Since(timing.start)) / float64(time.Millisecond)})
}
