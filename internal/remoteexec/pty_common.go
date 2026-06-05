package remoteexec

import (
	"time"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

type PtyStream interface {
	Send(*transport.Message) error
	Recv() (*transport.Message, error)
}

type PtyRunner struct {
	Shell          string
	Timeout        time.Duration
	MaxOutputBytes int64
}

func fallbackSize(value, fallback uint16) uint16 {
	if value == 0 {
		return fallback
	}
	return value
}
