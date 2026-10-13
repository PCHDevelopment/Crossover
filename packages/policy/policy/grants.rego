# Tier-3 grant lifetime checks (ARCHITECTURE §21.2). The grant command calls this policy before
# persisting a grant; it uses the same tier rules as `crossover.tiers`.
package crossover.grants

import data.crossover.tiers
import rego.v1

grant_check := {"allow": false, "reason": "expiry_not_in_future"} if {
	valid_input
	is_number(input.expires_in_ms)
	input.expires_in_ms <= 0
}

else := {"allow": false, "reason": "tier3_needs_expiry"} if {
	valid_input
	grant_tier == 3
	input.expires_in_ms == null
}

else := {"allow": false, "reason": "tier3_expiry_too_long"} if {
	valid_input
	grant_tier == 3
	input.expires_in_ms > 86400000
}

else := {"allow": true} if valid_input

grant_tier := tier if {
	tier := tiers.tier with input as {"base": input.base, "scope": input.scope}
}

valid_input if {
	is_object(input)
	is_string(input.base)
	valid_scope
	valid_expiry
}

valid_scope if {
	input.scope == null
}

else if {
	is_string(input.scope)
}

valid_expiry if {
	input.expires_in_ms == null
}

else if {
	is_number(input.expires_in_ms)
}
