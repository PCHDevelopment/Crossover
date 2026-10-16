# The authorization ladder (ARCHITECTURE §21.3, D9). `authorize()` in src/authorize.ts loads the
# facts below from the database, in the command's transaction, and asks this policy for the
# decision; it turns the decision into the error codes of §16.3. The order of the rules IS the
# policy: the first rule that applies wins, so a paused participant is refused before any
# capability is looked at, and a revocation beats every grant.
#
# `decision` is `{"allow": true}` or `{"allow": false, "code": <§16.3 code>, "reason": <string>}`.
# The compiled module is policy.wasm; regenerate it with `pnpm --filter @crossover/policy gen:wasm`.
package crossover.authz

import data.crossover.scope
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
else := deny("FORBIDDEN", "invalid_participant") if not valid_participant

# The room's own state (§5). A deleted room is not there at all, for anyone and for reads too.
else := deny("NOT_FOUND", "room_deleted") if input.room_status == "DELETED"

# A frozen room accepts mutations from its owner. Archived rooms stay read-only except for the
# owner's retention and unarchive controls.
else := deny("ROOM_PAUSED", "room_not_active") if {
	input.room_status != "ACTIVE"
	input.mutating == true
	not owner_may_act
}

# A path that is not a safe workspace path is refused before any grant is considered.
else := deny("FORBIDDEN", "invalid_path") if path_invalid

# A live revocation (DENY) covering the action beats everything below (§21.1).
else := deny("FORBIDDEN", "revoked") if denied

# A live grant covers the action. An approval gate (§22.2) makes it wait for a human unless the
# command was approved or another covering grant has no gate.
else := {"allow": true} if {
	covering_any
	covering_ungated
}

else := {"allow": true} if {
	covering_any
	input.approved == true
}

else := deny("APPROVAL_REQUIRED", "approval_required") if covering_any

# The role bundle and the authority cover it (§21.1).
else := {"allow": true} if in_bundle

# A per-path command's gate (T218): an ungated scoped grant of the capability is enough to
# reach the handler, which then authorizes each path itself.
else := {"allow": true} if per_path_gate

else := deny("FORBIDDEN", "unknown_capability") if not base in data.crossover.bundles.capabilities

else := deny("FORBIDDEN", "missing_capability")

# The role and the authority are ones this policy has a bundle for.
valid_participant if {
	input.participant.role in object.keys(data.crossover.bundles.roles)
	input.participant.authority in object.keys(data.crossover.bundles.authorities)
}

# What a role and an authority cover together (effectiveCapabilities in bundles.ts): the role's
# bundle, the authority's powers, task management for owners and admins, and the git
# capabilities for owners. The sets are generated from bundles.ts (bundles.gen.rego).
in_bundle if base in effective

effective := ((data.crossover.bundles.roles[input.participant.role] | data.crossover.bundles.authorities[input.participant.authority]) | governing_tasks) | owner_git

governing_tasks := data.crossover.bundles.governing_tasks if input.participant.authority != "MEMBER"

default governing_tasks := set()

owner_git := data.crossover.bundles.owner_git if input.participant.authority == "OWNER"

default owner_git := set()

# --- the action, its path, and which grants cover it (scope.rego) ------------------------------

# The capability asked for without its scope: what is before the first colon.
base := input.action if not contains(input.action, ":")

base := substring(input.action, 0, indexof(input.action, ":")) if contains(input.action, ":")

# A command that acts on a path names it in the resource, not in the action (`workspace.write` on
# `src/a.ts`), and only for an unscoped action on a path-scoped resource. Scoped grants and
# revocations are then matched against that path, so `workspace.write:secrets/**` applies to it just
# as to `workspace.write:secrets/k`.
request_path := input.resource_path if {
	is_string(input.resource_path)
	input.action == base
	split(base, ".")[0] in scope.path_scoped
}

has_request_path if is_string(request_path)

# "" names the workspace root (listing it): not a path to test against scopes, but fine.
path_invalid if {
	request_path != ""
	not scope.safe_request_path(request_path)
}

# Each grant and revocation is parsed once per decision; one that does not parse covers nothing.
parsed_grants := [{"p": p, "gated": grant.requires_approval} |
	some grant in input.grants
	p := scope.parsed(grant.capability)
]

parsed_denies := [p |
	some revocation in input.denies
	p := scope.parsed(revocation.capability)
]

requested := scope.parsed(input.action)

covers(p) if {
	has_request_path
	scope.covers_path(p, base, request_path)
}

covers(p) if {
	not has_request_path
	scope.covers_request(p, requested)
}

covering_any if {
	some grant in parsed_grants
	covers(grant.p)
}

covering_ungated if {
	some grant in parsed_grants
	not grant.gated
	covers(grant.p)
}

denied if {
	some p in parsed_denies
	covers(p)
}

# A per-path command's gate (T218): holding an ungated scoped grant of the capability is enough to
# reach the handler, which authorizes each path itself.
per_path_gate if {
	input.per_path == true
	not has_request_path
	input.action == base
	some grant in parsed_grants
	not grant.gated
	scope.has_scope_of(grant.p, base)
}

owner_may_act if {
	input.room_status == "PAUSED"
	input.participant.authority == "OWNER"
}

owner_may_act if {
	input.room_status == "ARCHIVED"
	input.participant.authority == "OWNER"
	input.method in {"rooms.set_retention", "rooms.unarchive"}
}

well_formed if {
	every fact in ["room_match", "mutating", "approved", "per_path"] {
		is_boolean(input[fact])
	}
	is_string(input.room_status)
	is_string(input.method)
	is_string(input.action)
	input.resource_path == null
	grants_well_formed
	participant_well_formed
}

well_formed if {
	every fact in ["room_match", "mutating", "approved", "per_path"] {
		is_boolean(input[fact])
	}
	is_string(input.room_status)
	is_string(input.method)
	is_string(input.action)
	is_string(input.resource_path)
	grants_well_formed
	participant_well_formed
}

grants_well_formed if {
	every grant in input.grants {
		is_string(grant.capability)
		is_boolean(grant.requires_approval)
	}
	every revocation in input.denies {
		is_string(revocation.capability)
	}
	is_array(input.grants)
	is_array(input.denies)
}

participant_well_formed if input.participant == null

participant_well_formed if {
	is_string(input.participant.status)
	is_string(input.participant.authority)
	is_string(input.participant.role)
}
