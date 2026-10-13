# Unit tests of the authorization ladder: `opa test policy/`. Each test changes one fact of a
# passing input, so what the rule order means is written down here as well as in authz.rego.
package crossover.authz_test

import data.crossover.authz
import rego.v1

# An active developer member of an active room whose role bundle covers the action.
base := {
	"room_match": true,
	"participant": {"status": "ACTIVE", "authority": "MEMBER", "role": "DEVELOPER"},
	"room_status": "ACTIVE",
	"mutating": true,
	"approved": false,
	"action": "messages.send",
	"resource_path": null,
	"per_path": false,
	"grants": [],
	"denies": [],
}

ungated(capability) := {"capability": capability, "requires_approval": false}

gated(capability) := {"capability": capability, "requires_approval": true}

revocation(capability) := {"capability": capability}

observer := {"status": "ACTIVE", "authority": "MEMBER", "role": "OBSERVER"}

# In the catalog, but not in a developer's bundle and not an authority power a member has.
not_in_bundle := "room.freeze"

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
	for_odd_role := object.union(base.participant, {"role": "WIZARD"})
	refused(with_fact("participant", for_odd_role), "FORBIDDEN", "invalid_participant")
	odd_authority := object.union(base.participant, {"authority": "KING"})
	refused(with_fact("participant", odd_authority), "FORBIDDEN", "invalid_participant")
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
	input_ := object.union(base, {"action": "workspace.write", "resource_path": "../x", "grants": [ungated("workspace.write")]})
	refused(input_, "FORBIDDEN", "invalid_path")
}

test_a_revocation_beats_the_role_bundle_and_every_grant if {
	input_ := object.union(base, {"denies": [revocation("messages.send")], "grants": [ungated("messages.send")]})
	refused(input_, "FORBIDDEN", "revoked")
}

test_an_ungated_grant_allows_without_the_bundle if {
	input_ := object.union(base, {"action": not_in_bundle, "grants": [ungated(not_in_bundle)]})
	decide(input_) == {"allow": true}
}

test_a_gated_grant_waits_for_approval_even_when_the_bundle_allows if {
	input_ := object.union(base, {"grants": [gated("messages.send")]})
	refused(input_, "APPROVAL_REQUIRED", "approval_required")
}

test_an_approved_command_passes_the_gate if {
	input_ := object.union(base, {"grants": [gated("messages.send")], "approved": true})
	decide(input_) == {"allow": true}
}

test_approval_never_overrides_a_revocation if {
	input_ := object.union(base, {"denies": [revocation("messages.send")], "grants": [gated("messages.send")], "approved": true})
	refused(input_, "FORBIDDEN", "revoked")
}

test_the_per_path_gate_lets_a_scoped_grant_reach_the_handler if {
	input_ := object.union(base, {"action": "workspace.write", "per_path": true, "participant": observer, "grants": [ungated("workspace.write:src/**")]})
	decide(input_) == {"allow": true}
}

test_unknown_capability if {
	input_ := object.union(base, {"action": "tasks.*"})
	refused(input_, "FORBIDDEN", "unknown_capability")
}

test_missing_capability if refused(with_fact("action", not_in_bundle), "FORBIDDEN", "missing_capability")

# Facts that are missing or of the wrong type decide nothing: always a refusal.
test_missing_facts_are_refused if {
	every fact in ["room_match", "mutating", "approved", "per_path", "action", "resource_path", "grants", "denies", "room_status", "participant"] {
		input_ := object.remove(base, [fact])
		refused(input_, "FORBIDDEN", "invalid_input")
	}
}

test_wrongly_typed_facts_are_refused if {
	refused(with_fact("action", true), "FORBIDDEN", "invalid_input")
	refused(with_fact("mutating", 1), "FORBIDDEN", "invalid_input")
	refused(with_fact("grants", [{"capability": "messages.send", "requires_approval": "no"}]), "FORBIDDEN", "invalid_input")
	refused(with_fact("denies", [{"capability": 1}]), "FORBIDDEN", "invalid_input")
	refused(with_fact("resource_path", 5), "FORBIDDEN", "invalid_input")
}

test_no_input_at_all_is_refused if {
	d := authz.decision with input as {}
	d.allow == false
}

# What a role and an authority cover together (effectiveCapabilities in bundles.ts). The
# exhaustive comparison with the TypeScript is in src/bundles-oracle.test.ts.
covers(role, authority, capability) if {
	participant := {"status": "ACTIVE", "authority": authority, "role": role}
	d := decide(object.union(base, {"participant": participant, "action": capability}))
	d == {"allow": true}
}

test_owners_and_admins_manage_tasks_whatever_their_role if {
	covers("OBSERVER", "OWNER", "tasks.assign")
	covers("OBSERVER", "ADMIN", "tasks.assign")
	not covers("OBSERVER", "MEMBER", "tasks.assign")
}

test_only_owners_get_the_git_capabilities_without_the_lead_role if {
	covers("OBSERVER", "OWNER", "git.import")
	not covers("OBSERVER", "ADMIN", "git.import")
	covers("LEAD", "MEMBER", "git.import")
}

test_authority_powers_are_not_in_the_role_bundles if {
	covers("LEAD", "OWNER", "room.freeze")
	not covers("LEAD", "ADMIN", "room.freeze")
	not covers("LEAD", "MEMBER", "room.freeze")
}

# A live grant covers the action by its scope (the matching itself is tested in scope_test.rego).
test_a_scoped_grant_covers_only_its_paths if {
	grants := [ungated("workspace.write:src/**")]
	input_ := object.union(base, {"action": "workspace.write", "participant": observer, "grants": grants})
	allowed := object.union(input_, {"resource_path": "src/a/b.ts"})
	decide(allowed) == {"allow": true}
	refused(object.union(input_, {"resource_path": "docs/a.md"}), "FORBIDDEN", "missing_capability")
}

test_a_scoped_revocation_applies_to_the_path_of_the_request if {
	input_ := object.union(base, {"action": "workspace.write", "resource_path": "secrets/k", "denies": [revocation("workspace.write:secrets/**")]})
	refused(input_, "FORBIDDEN", "revoked")
}

test_the_per_path_gate_needs_a_scoped_ungated_grant_and_the_unscoped_action if {
	gate := object.union(base, {"action": "workspace.write", "per_path": true, "participant": observer})
	refused(object.union(gate, {"grants": [gated("workspace.write:src/**")]}), "FORBIDDEN", "missing_capability")
	refused(object.union(gate, {"per_path": false, "grants": [ungated("workspace.write:src/**")]}), "FORBIDDEN", "missing_capability")
	decide(object.union(gate, {"grants": [ungated("workspace.write:src/**")]})) == {"allow": true}
}
