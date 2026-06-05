package filesync

// platformWatcher is the OS-specific change source the Engine wraps in
// Watch(). It exists because macOS kqueue (fsnotify's backend) opens
// one FD per watched file — a server holding several large workspaces
// open simultaneously blows past launchd's 256-FD default in minutes.
// FSEvents on darwin needs O(1) state per watched root regardless of
// file count, so we use it there; Linux (inotify) and Windows
// (ReadDirectoryChangesW) keep fsnotify, which is already FD-efficient
// on those kernels.
//
// Events emits OS-absolute paths whose content may have changed. Spurious
// events are tolerated by the session-level outbound queue, which coalesces
// repeated paths before sending. Errors carries transport-level failures
// (kernel buffer overruns, dropped events) that the caller can log and
// respond to. Close releases all OS resources and unblocks any in-flight
// Read on Events.
type platformWatcher interface {
	Events() <-chan string
	Errors() <-chan error
	Close() error
}

const watcherEventBuffer = 32768

var newWatcher = newPlatformWatcher
