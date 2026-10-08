import { CrossoverClient, type RoomClient, type RoomSessionInfo } from "@crossover/sdk";

/** One client for the app: the server that served it. */
export const client = new CrossoverClient({
  baseUrl: window.location.origin,
  clientName: "crossover-web",
  clientVersion: "0.0.0",
});

// The user session lives for the tab only; room tokens are never stored (opening a room asks for
// fresh ones; the access token lasts an hour, then the room is re-entered).
const KEY = "crossover.session";

export const getSession = (): string | undefined => {
  try {
    return window.sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
};
export const setSession = (token: string | undefined): void => {
  try {
    if (token) window.sessionStorage.setItem(KEY, token);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // storage blocked: the session lasts until reload
  }
};

export interface OpenRoom {
  room: RoomClient;
  me: Omit<RoomSessionInfo, "tokens">;
}

/** Enter a room as the signed-in user. */
export async function openRoom(session: string, roomId: string): Promise<OpenRoom> {
  const { tokens, ...me } = await client.roomSession(session, roomId);
  return { room: client.room(roomId, tokens.access_token), me };
}
