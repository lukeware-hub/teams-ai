package scheduler

import (
	"context"
	"time"
)

func Start(ctx context.Context, every time.Duration, tick func(context.Context)) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick(ctx)
		}
	}
}
