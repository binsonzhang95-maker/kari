package remoteexec

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/binsonzhang95-maker/kari/internal/transport"
)

const (
	defaultCommandTimeout = 5 * time.Minute
	defaultMaxOutputBytes = 10 << 20
)

type Sender interface {
	Send(*transport.Message) error
}

type Runner struct {
	Shell          string
	Timeout        time.Duration
	MaxOutputBytes int64
}

func (r Runner) Run(ctx context.Context, sender Sender, req *transport.Message) error {
	if req.Command == "" {
		return errors.New("command is required")
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = defaultCommandTimeout
	}
	maxOutput := r.MaxOutputBytes
	if maxOutput <= 0 {
		maxOutput = defaultMaxOutputBytes
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, shellName(r.Shell), shellArgs(r.Shell, req.Command)...)
	if req.WorkDir != "" {
		cmd.Dir = req.WorkDir
	}
	cmd.Env = prepareShellEnv(os.Environ())

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	var sent int64
	var mu sync.Mutex
	var wg sync.WaitGroup
	sendStream := func(name string, reader io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(reader)
		buf := make([]byte, 0, 64*1024)
		scanner.Buffer(buf, 1024*1024)
		for scanner.Scan() {
			line := append(scanner.Bytes(), '\n')
			mu.Lock()
			if sent+int64(len(line)) > maxOutput {
				mu.Unlock()
				cancel()
				return
			}
			sent += int64(len(line))
			err := sender.Send(&transport.Message{
				Type:      transport.MessageCommandData,
				CommandID: req.CommandID,
				Stream:    name,
				Data:      append([]byte(nil), line...),
			})
			mu.Unlock()
			if err != nil {
				cancel()
				return
			}
		}
	}

	wg.Add(2)
	go sendStream("stdout", stdout)
	go sendStream("stderr", stderr)
	waitErr := cmd.Wait()
	wg.Wait()

	exitCode := 0
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		exitCode = exitErr.ExitCode()
	} else if waitErr != nil {
		exitCode = -1
	}
	if runCtx.Err() == context.DeadlineExceeded {
		waitErr = fmt.Errorf("command timed out after %s", timeout)
		exitCode = -1
	}
	errText := ""
	if waitErr != nil {
		errText = waitErr.Error()
	}
	return sender.Send(&transport.Message{
		Type:      transport.MessageCommandDone,
		CommandID: req.CommandID,
		ExitCode:  exitCode,
		Error:     errText,
	})
}

func shellName(configured string) string {
	if configured != "" && configured != "auto" {
		return configured
	}
	switch runtime.GOOS {
	case "windows":
		return "powershell"
	case "darwin":
		return "/bin/zsh"
	default:
		return "/bin/sh"
	}
}

func shellArgs(shell, command string) []string {
	name := shellName(shell)
	switch name {
	case "powershell", "powershell.exe", "pwsh", "pwsh.exe":
		return []string{"-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command}
	case "/bin/zsh", "zsh", "/bin/sh", "sh", "bash", "/bin/bash":
		return []string{"-lc", command}
	default:
		return []string{"-c", command}
	}
}
