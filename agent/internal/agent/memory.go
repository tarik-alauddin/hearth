package agent

import (
	"bufio"
	"io"
	"os"
	"strconv"
	"strings"
)

// HostMemoryMiB returns the instance's total memory from /proc/meminfo, or 0 if unknown
// (e.g. not on Linux). Adapters fall back to a minimum heap when it's 0.
func HostMemoryMiB() int {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	return parseMemTotalMiB(f)
}

func parseMemTotalMiB(r io.Reader) int {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kib, err := strconv.Atoi(fields[1])
			if err != nil {
				return 0
			}
			return kib / 1024
		}
	}
	return 0
}
