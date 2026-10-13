import { CrossoverClient, type RoomClient, type RoomSessionInfo } from "@crossover/sdk";

/** One client for the app: the server that served it. */
export const client = new CrossoverClient({
  baseUrl: window.location.origin,
  clientName: "crossover-web",
  clientVersion: "0.0.0",
});

// Remove bearer sessions from older web builds. Current browser sessions use an HttpOnly cookie.
try {
  window.sessionStorage.removeItem("crossover.session");
} catch {
  // Storage may be disabled; the app never depends on it.
}

export interface OpenRoom {
  room: RoomClient;
  me: Omit<RoomSessionInfo, "tokens">;
}

/** Enter a room as the signed-in user. */
export async function openRoom(roomId: string): Promise<OpenRoom> {
  const { tokens, ...me } = await client.roomSession(undefined, roomId);
  return { room: client.room(roomId, tokens.access_token), me };
}
