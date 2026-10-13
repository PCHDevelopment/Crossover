# Unit tests of the authorization ladder: `opa test policy/`. Each test changes one fact of a
# passing input, so what the rule order means is written down here as well as in authz.rego.
package crossover.authz_test

import data.crossover.authz
import rego.v1

# An active member of an active room whose role bundle covers the action.
base := {
	"room_match": true,
	"participant": {"status": "ACTIVE", "authority": "MEMBER", "valid": true},
	"room_status": "ACTIVE",
	"mutating": true,
	"path_invalid": false,
	"denied": false,
	"covering": {"any": false, "ungated": false},
	"approved": false,
	"in_bundle": true,
	"per_path_gate": false,
	"known_capability": true,
}

with_fact(key, value) := object.union(base, {key: value})

decide(input_) := d if {
	d := authz.decision with input as input_
}

refused(input_, code, reason) if {
	d := decide(input_)
	d == {"allow": false, "code": code, "reason": reason}
}

test_allowed_by_the_role_bundle if decide(base) == {"allow": true}

test_room_mismatch if refused(with_fact("room_match", false), "FORBIDDEN", "room_mismatch")

test_not_a_participant if refused(with_fact("participant", null), "FORBIDDEN", "not_a_participant")

test_paused_participant_even_for_a_read if {
	paused := object.union(base.participant, {"status": "PAUSED"})
	input_ := object.union(with_fact("participant", paused), {"mutating": false})
	refused(input_, "PARTICIPANT_PAUSED", "participant_paused")
}

test_other_statuses_name_the_status if {
	removed := object.union(base.participant, {"status": "REMOVED"})
	refused(with_fact("participant", removed), "FORBIDDEN", "participant_removed")
}

test_invalid_participant if {
	odd := object.union(base.participant, {"valid": false})
	refused(with_fact("participant", odd), "FORBIDDEN", "invalid_participant")
}

test_deleted_room_is_not_found_even_for_a_read if {
	input_ := object.union(base, {"room_status": "DELETED", "mutating": false})
	refused(input_, "NOT_FOUND", "room_deleted")
}

test_archived_room_refuses_mutations_even_from_the_owner if {
	owner := object.union(base.participant, {"authority": "OWNER"})
	input_ := object.union(base, {"room_status": "ARCHIVED", "participant": owner})
	refused(input_, "ROOM_PAUSED", "room_not_active")
}

test_frozen_room_refuses_mutations_except_from_the_owner if {
	frozen := object.union(base, {"room_status": "PAUSED"})
	refused(frozen, "ROOM_PAUSED", "room_not_active")
	owner := object.union(base.participant, {"authority": "OWNER"})
	decide(object.union(frozen, {"participant": owner})) == {"allow": true}
}

test_reads_pass_the_room_gate if {
	input_ := object.union(base, {"room_status": "ARCHIVED", "mutating": false})
	decide(input_) == {"allow": true}
}

test_invalid_path_is_refused_before_grants if {
	input_ := object.union(base, {"path_invalid": true, "covering": {"any": true, "ungated": true}})
	refused(input_, "FORBIDDEN", "invalid_path")
}

test_a_revocation_beats_the_role_bundle_and_every_grant if {
	input_ := object.union(base, {"denied": true, "covering": {"any": true, "ungated": true}})
	refused(input_, "FORBIDDEN", "revoked")
}

test_an_ungated_grant_allows_without_the_bundle if {
	input_ := object.union(base, {"in_bundle": false, "covering": {"any": true, "ungated": true}})
	decide(input_) == {"allow": true}
}

test_a_gated_grant_waits_for_approval_even_when_the_bundle_allows if {
	input_ := object.union(base, {"covering": {"any": true, "ungated": false}})
	refused(input_, "APPROVAL_REQUIRED", "approval_required")
}

test_an_approved_command_passes_the_gate if {
	input_ := object.union(base, {"covering": {"any": true, "ungated": false}, "approved": true})
	decide(input_) == {"allow": true}
}

test_approval_never_overrides_a_revocation if {
	input_ := object.union(base, {"denied": true, "covering": {"any": true, "ungated": false}, "approved": true})
	refused(input_, "FORBIDDEN", "revoked")
}

test_the_per_path_gate_lets_a_scoped_grant_reach_the_handler if {
	input_ := object.union(base, {"in_bundle": false, "per_path_gate": true})
	decide(input_) == {"allow": true}
}

test_unknown_capability if {
	input_ := object.union(base, {"in_bundle": false, "known_capability": false})
	refused(input_, "FORBIDDEN", "unknown_capability")
}

test_missing_capability if refused(with_fact("in_bundle", false), "FORBIDDEN", "missing_capability")

# Facts that are missing or of the wrong type decide nothing: always a refusal.
test_missing_facts_are_refused if {
	every fact in ["room_match", "mutating", "path_invalid", "denied", "approved", "in_bundle", "per_path_gate", "known_capability", "room_status", "covering", "participant"] {
		input_ := object.remove(base, [fact])
		refused(input_, "FORBIDDEN", "invalid_input")
	}
}

test_wrongly_typed_facts_are_refused if {
	refused(with_fact("in_bundle", "true"), "FORBIDDEN", "invalid_input")
	refused(with_fact("mutating", 1), "FORBIDDEN", "invalid_input")
	refused(with_fact("covering", {"any": "yes", "ungated": true}), "FORBIDDEN", "invalid_input")
}

test_no_input_at_all_is_refused if {
	d := authz.decision with input as {}
	d.allow == false
}
