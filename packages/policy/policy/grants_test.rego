package crossover.grants_test

import data.crossover.grants
import rego.v1

test_nonpositive_expiry_is_refused_before_tier_rules if {
	grants.grant_check == {"allow": false, "reason": "expiry_not_in_future"} with input as {"base": "messages.read", "scope": null, "expires_in_ms": -1}
	grants.grant_check == {"allow": false, "reason": "expiry_not_in_future"} with input as {"base": "aws.deploy_lambda", "scope": "prod", "expires_in_ms": 0}
}

test_tier3_needs_an_expiry if {
	grants.grant_check == {"allow": false, "reason": "tier3_needs_expiry"} with input as {"base": "aws.deploy_lambda", "scope": "prod", "expires_in_ms": null}
	grants.grant_check == {"allow": false, "reason": "tier3_needs_expiry"} with input as {"base": "capabilities.grant_tier3", "scope": null, "expires_in_ms": null}
}

test_tier3_expiry_boundaries if {
	grants.grant_check == {"allow": true} with input as {"base": "aws.deploy_lambda", "scope": "prod", "expires_in_ms": 1}
	grants.grant_check == {"allow": true} with input as {"base": "aws.deploy_lambda", "scope": "prod", "expires_in_ms": 3600000}
	grants.grant_check == {"allow": true} with input as {"base": "aws.deploy_lambda", "scope": "prod", "expires_in_ms": 86400000}
	grants.grant_check == {"allow": false, "reason": "tier3_expiry_too_long"} with input as {"base": "aws.deploy_lambda", "scope": "prod", "expires_in_ms": 86400001}
}

test_non_tier3_does_not_get_the_tier3_lifetime_limit if {
	grants.grant_check == {"allow": true} with input as {"base": "messages.send", "scope": null, "expires_in_ms": null}
	grants.grant_check == {"allow": true} with input as {"base": "aws.deploy_lambda", "scope": "staging-x", "expires_in_ms": 86400001}
}
