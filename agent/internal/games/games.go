// Package games lists the game adapters the agent can run, keyed by the game IDs in
// packages/shared (GAMES). Adding a game: write its adapter package and add it here.
package games

import (
	"github.com/tarik-alauddin/hearth/agent/internal/game"
	"github.com/tarik-alauddin/hearth/agent/internal/game/minecraft"
)

func Registry() map[string]game.Factory {
	return map[string]game.Factory{
		"minecraft-java": func() game.Adapter { return minecraft.New() },
	}
}
