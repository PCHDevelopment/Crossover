# The authorization ladder (ARCHITECTURE §21.3, D9). `authorize()` in src/authorize.ts loads the
# facts below from the database, in the command's transaction, and asks this policy for the
# decision; it turns the decision into the error codes of §16.3. The order of the rules IS the
# policy: the first rule that applies wins, so a paused participant is refused before any
# capability is looked at, and a revocation beats every grant.
#
# `decision` is `{"allow": true}` or `{"allow": false, "code": <§16.3 code>, "reason": <string>}`.
# The compiled module is policy.wasm; regenerate it with `pnpm --filter @crossover/policy gen:wasm`.
package crossover.authz

import rego.v1

# Anything the rules below do not decide is a refusal, never an allow.
default decision := {"allow": false, "code": "FORBIDDEN", "reason": "invalid_input"}

deny(code, reason) := {"allow": false, "code": code, "reason": reason}

# Every fact must be present and of the right type, or nothing is decided from them.
decision := deny("FORBIDDEN", "invalid_input") if not well_formed

# The room of the resource is not the room of the principal.
else := deny("FORBIDDEN", "room_mismatch") if input.room_match == false

# Not an (existing) participant of the room.
else := deny("FORBIDDEN", "not_a_participant") if input.participant == null

# A paused participant can do nothing, reads included.
else := deny("PARTICIPANT_PAUSED", "participant_paused") if input.participant.status == "PAUSED"

# Any other status (INVITED, REMOVED, ...) is refused with the status as the reason.
else := deny("FORBIDDEN", concat("", ["participant_", lower(input.participant.status)])) if input.participant.status != "ACTIVE"

# The database CHECKs make this unreachable; refuse rather than guess.
else := deny("FORBIDDEN", "invalid_participant") if input.participant.valid == false

# The room's own state (§5). A deleted room is not there at all, for anyone and for reads too.
else := deny("NOT_FOUND", "room_deleted") if input.room_status == "DELETED"

# A frozen room (PAUSED) accepts mutations from its owner only; an archived room accepts none.
# Reads always pass this gate.
else := deny("ROOM_PAUSED", "room_not_active") if {
	input.room_status != "ACTIVE"
	input.mutating == true
	not owner_may_act
}

# A path that is not a safe workspace path is refused before any grant is considered.
else := deny("FORBIDDEN", "invalid_path") if input.path_invalid == true

# A live revocation (DENY) covering the action beats everything below (§21.1).
else := deny("FORBIDDEN", "revoked") if input.denied == true

# A live grant covers the action. An approval gate (§22.2) makes it wait for a human unless the
# command was approved or another covering grant has no gate.
else := {"allow": true} if {
	input.covering.any == true
	input.covering.ungated == true
}

else := {"allow": true} if {
	input.covering.any == true
	input.approved == true
}

else := deny("APPROVAL_REQUIRED", "approval_required") if input.covering.any == true

# The role bundle and the authority cover it (§21.1).
else := {"allow": true} if input.in_bundle == true

# A per-path command's gate (T218): an ungated scoped grant of the capability is enough to
# reach the handler, which then authorizes each path itself.
else := {"allow": true} if input.per_path_gate == true

else := deny("FORBIDDEN", "unknown_capability") if input.known_capability == false

else := deny("FORBIDDEN", "missing_capability")

owner_may_act if {
	input.room_status == "PAUSED"
	input.participant.authority == "OWNER"
}

well_formed if {
	every fact in ["room_match", "mutating", "path_invalid", "denied", "approved", "in_bundle", "per_path_gate", "known_capability"] {
		is_boolean(input[fact])
	}
	is_string(input.room_status)
	is_boolean(input.covering.any)
	is_boolean(input.covering.ungated)
	participant_well_formed
}

participant_well_formed if input.participant == null

participant_well_formed if {
	is_string(input.participant.status)
	is_string(input.participant.authority)
	is_boolean(input.participant.valid)
}
