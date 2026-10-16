package crossover.tiers_test

import data.crossover.tiers
import rego.v1

test_reads_are_tier_0 if {
	tiers.tier == 0 with input as {"base": "tasks.read", "scope": null}
	tiers.tier == 0 with input as {"base": "github.read_repository", "scope": "org/repo"}
}

test_room_internal_writes_are_tier_1 if {
	tiers.tier == 1 with input as {"base": "messages.send", "scope": null}
	tiers.tier == 1 with input as {"base": "workspace.write", "scope": "src/**"}
}

test_external_capabilities_use_their_table_tier if {
	tiers.tier == 2 with input as {"base": "slack.post_message", "scope": null}
	tiers.tier == 2 with input as {"base": "github.create_pull_request", "scope": "org/repo"}
}

test_grant_tier3_is_tier_3 if {
	tiers.tier == 3 with input as {"base": "capabilities.grant_tier3", "scope": null}
}

test_scoped_rule if {
	tiers.tier == 2 with input as {"base": "aws.deploy_lambda", "scope": "staging-api"}
	tiers.tier == 3 with input as {"base": "aws.deploy_lambda", "scope": "prod-api"}
	tiers.tier == 3 with input as {"base": "aws.deploy_lambda", "scope": "Staging-api"}
	tiers.tier == 3 with input as {"base": "aws.deploy_lambda", "scope": "function/staging-*"}
	tiers.tier == 3 with input as {"base": "aws.deploy_lambda", "scope": null}
}

test_unknown_is_tier_3 if {
	tiers.tier == 3 with input as {"base": "nope.nothing", "scope": null}
	tiers.tier == 3 with input as {"base": "constructor", "scope": null}
	tiers.tier == 3 with input as {"base": "", "scope": null}
}

test_malformed_input_is_tier_3 if {
	tiers.tier == 3 with input as {}
	tiers.tier == 3 with input as {"base": 7, "scope": null}
	tiers.tier == 3 with input as {"base": null}
	tiers.tier == 3 with input as {"base": "aws.deploy_lambda", "scope": 5}
}
