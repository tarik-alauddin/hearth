// Command hearth-agent runs on each game server instance and manages the game container.
// It is a stub until M2.
package main

import "fmt"

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	fmt.Println("hearth-agent", version)
}
