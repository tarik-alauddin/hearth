package container

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// recorder captures docker invocations and the env file contents at run time.
type recorder struct {
	calls   [][]string
	envFile string
}

func (r *recorder) run(_ context.Context, args ...string) (string, error) {
	r.calls = append(r.calls, args)
	if args[0] == "run" {
		i := slices.Index(args, "--env-file")
		b, _ := os.ReadFile(args[i+1])
		r.envFile = string(b)
	}
	return "", nil
}

func TestStart(t *testing.T) {
	rec := &recorder{}
	d := &Docker{run: rec.run}
	data := filepath.Join(t.TempDir(), "data")

	err := d.Start(context.Background(), Spec{
		Name:  "hearth-game",
		Image: "example/game",
		Env:   map[string]string{"B": "2", "SECRET": "hunter2"},
		Ports: []Port{
			{HostIP: "0.0.0.0", HostPort: 25565, ContainerPort: 25565, Protocol: "tcp"},
			{HostIP: "127.0.0.1", HostPort: 25575, ContainerPort: 25575, Protocol: "tcp"},
		},
		Mounts:      []Mount{{Source: data, Target: "/data"}},
		StopTimeout: 60 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(data); err != nil {
		t.Errorf("mount source not created: %v", err)
	}
	if got := rec.calls[0]; !slices.Equal(got, []string{"rm", "--force", "hearth-game"}) {
		t.Errorf("first call %v, want removal of the old container", got)
	}
	run := strings.Join(rec.calls[1], " ")
	for _, want := range []string{
		"run --detach --name hearth-game",
		"--stop-timeout 60",
		"--publish 0.0.0.0:25565:25565/tcp",
		"--publish 127.0.0.1:25575:25575/tcp",
		"--volume " + data + ":/data",
	} {
		if !strings.Contains(run, want) {
			t.Errorf("run args missing %q:\n%s", want, run)
		}
	}
	if !strings.HasSuffix(run, " example/game") {
		t.Errorf("image should be last: %s", run)
	}
	if strings.Contains(run, "hunter2") {
		t.Error("secret leaked onto the command line")
	}
	if rec.envFile != "B=2\nSECRET=hunter2\n" {
		t.Errorf("env file %q", rec.envFile)
	}
}

func TestStartRejectsNewlinesInEnv(t *testing.T) {
	d := &Docker{run: (&recorder{}).run}
	err := d.Start(context.Background(), Spec{Name: "x", Image: "y", Env: map[string]string{"A": "1\nB=2"}})
	if err == nil {
		t.Fatal("expected an error")
	}
}

func TestRunningAndWait(t *testing.T) {
	d := &Docker{run: func(_ context.Context, args ...string) (string, error) {
		switch args[0] {
		case "inspect":
			return "true", nil
		case "wait":
			return "137", nil
		}
		return "", nil
	}}
	if running, err := d.Running(context.Background(), "x"); err != nil || !running {
		t.Errorf("Running = %v, %v", running, err)
	}
	if code, err := d.Wait(context.Background(), "x"); err != nil || code != 137 {
		t.Errorf("Wait = %v, %v", code, err)
	}
}
