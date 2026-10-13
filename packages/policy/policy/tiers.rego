# The risk tier (ARCHITECTURE §21.2, D14) of a capability's base (`<resource>.<action>`) and
# optional concrete scope, the Rego side of `capabilityTier` in src/tiers.ts. `tierOf` parses the
# capability string and asks this policy for the tier of its base and scope; the data it
# classifies from (tiers.gen.rego) is generated from tiers.ts and the capability catalog.
#
#   input: {"base": <string>, "scope": <string> or null}
#   tier:  0..3
#
#   - a base with a scope rule: the rule's tier when the scope starts with its prefix, otherwise
#     (also with no scope) its stricter one;
#   - one of the external capabilities §21.2 names: its tier;
#   - a catalog capability: 3 if it is listed as tier 3, else 1 if it changes state, 0 if not;
#   - **anything else is 3**, and so is an input that is not a base: an unclassified capability
#     can't be handed out as if it were harmless (fail closed).
package crossover.tiers

import data.crossover.tier_data
import rego.v1

default tier := 3

tier := classified if is_string(input.base)

classified := scoped_tier(tier_data.scoped[input.base]) if tier_data.scoped[input.base]

else := tier_data.external[input.base] if tier_data.external[input.base] != null

else := 3 if input.base in tier_data.catalog_tier_3

else := 1 if tier_data.catalog_mutating[input.base] == true

else := 0 if tier_data.catalog_mutating[input.base] == false

else := 3

scoped_tier(rule) := rule.tier if {
	is_string(input.scope)
	startswith(input.scope, rule.prefix)
} else := rule.otherwise
