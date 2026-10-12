package cli

import (
	"encoding/json"
	"flag"
	"net/http"
)

func (a *app) login(args []string) error {
	var tokenFromStdin bool
	positional, err := parseFlags("login", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&tokenFromStdin, "session-token-stdin", false, "read the existing user session token from stdin")
	})
	if err != nil {
		return err
	}
	if len(positional) != 0 {
		return usageError("login takes no positional arguments")
	}
	if !tokenFromStdin {
		return usageError("login requires --session-token-stdin")
	}
	if err := a.requireServer(); err != nil {
		return err
	}
	token, err := readSecretLine(a.stdin, "session token")
	if err != nil {
		return err
	}
	a.transientSecrets = append(a.transientSecrets, token)
	if _, err := a.client.requestJSON(a.ctx, http.MethodGet, "/v1/rooms", token, nil); err != nil {
		return err
	}
	updated, err := updateConfig(a.cfgPath, func(current *Config) (bool, error) {
		current.Server = a.server
		current.UserSession = token
		return true, nil
	})
	if err != nil {
		return localError("save credentials: " + err.Error())
	}
	*a.cfg = *updated
	return a.writeJSON(map[string]any{"authenticated": true, "server": a.server})
}

func (a *app) join(args []string) error {
	var tokenFromStdin bool
	var manifestPath string
	positional, err := parseFlags("join", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&tokenFromStdin, "invite-token-stdin", false, "read the one-time invite token from stdin")
		fs.StringVar(&manifestPath, "manifest", "", "agent manifest JSON file")
	})
	if err != nil {
		return err
	}
	if len(positional) != 1 {
		return usageError("join requires exactly one ROOM_ID")
	}
	if !tokenFromStdin || manifestPath == "" {
		return usageError("join requires --invite-token-stdin and --manifest FILE")
	}
	if err := a.requireServer(); err != nil {
		return err
	}
	manifestData, err := readFile(manifestPath, 1024*1024)
	if err != nil {
		return err
	}
	manifest, err := objectFromJSON(manifestData)
	if err != nil {
		return usageError("manifest must be a JSON object: " + err.Error())
	}
	token, err := readSecretLine(a.stdin, "invite token")
	if err != nil {
		return err
	}
	a.transientSecrets = append(a.transientSecrets, token)
	body, err := json.Marshal(map[string]any{"token": token, "manifest": manifest})
	if err != nil {
		return malformedError("encode join request: " + err.Error())
	}
	roomID := positional[0]
	data, err := a.client.requestJSON(a.ctx, http.MethodPost, "/v1/rooms/"+escapePath(roomID)+"/join", "", body)
	if err != nil {
		return err
	}
	var response struct {
		ParticipantID string     `json:"participant_id"`
		Tokens        RoomTokens `json:"tokens"`
	}
	if err := json.Unmarshal(data, &response); err != nil || response.Tokens.AccessToken == "" {
		return malformedError("join response has no room access token")
	}
	updated, err := updateConfig(a.cfgPath, func(current *Config) (bool, error) {
		current.Server = a.server
		current.Rooms[roomKey(a.server, roomID)] = response.Tokens
		return true, nil
	})
	if err != nil {
		return localError("save room credentials: " + err.Error())
	}
	*a.cfg = *updated
	return a.writeJSON(map[string]any{
		"joined": true, "room_id": roomID, "participant_id": response.ParticipantID,
	})
}
