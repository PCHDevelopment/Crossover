/**
 * Who is issuing a command: the result of authenticating an access token (T207).
 *
 * This is a snapshot taken when the token was checked. A participant's role, authority and
 * status can change afterwards, so the policy (T208) must re-read the participant inside the
 * command's transaction rather than trust these fields for access decisions.
 */
export interface Principal {
  participant_id: string;
  /** The room the participant belongs to; the gateway checks it against the request's room. */
  room_id: string;
  kind: "HUMAN" | "AGENT";
  authority: "OWNER" | "ADMIN" | "MEMBER";
  role: "LEAD" | "DEVELOPER" | "REVIEWER" | "OBSERVER";
}
