# Unit tests of the pattern translators and the capability matching in scope.rego: `opa test policy/`.
# The comparison with the TypeScript (capability.ts, glob.ts) over thousands of generated cases is
# src/scope-oracle.test.ts.
package crossover.scope_test

import data.crossover.scope
import rego.v1

# --- the translators, directly -----------------------------------------------------------------

test_plain_regex_is_anchored_and_turns_only_the_wildcards_into_syntax if {
	scope.plain_regex("org/*") == `^org/.*$`
	scope.plain_regex("a?c") == `^a.c$`
	scope.plain_regex("plain") == `^plain$`
}

test_plain_regex_escapes_every_metacharacter if {
	scope.plain_regex(`a.b+c(d)e|f^g$h[i]j{k}l\m`) == `^a\.b\+c\(d\)e\|f\^g\$h\[i\]j\{k\}l\\m$`
}

test_path_regex_is_anchored_and_stops_wildcards_at_a_separator if {
	scope.path_regex("src/*.ts") == `^src/[^/]*\.ts$`
	scope.path_regex("a?c") == `^a[^/]c$`
}

test_path_regex_double_star if {
	scope.path_regex("src/**") == `^src/.+$`
	scope.path_regex("**") == `^.+$`
	scope.path_regex("a/**/b") == `^a/(.*/)?b$`
	scope.path_regex("**/b") == `^(.*/)?b$`
}

test_path_regex_escapes_every_metacharacter if {
	scope.path_regex(`a.b+c(d)|^$[]{}`) == `^a\.b\+c\(d\)\|\^\$\[\]\{\}$`
}

# A literal metacharacter in a pattern matches itself and nothing it would mean as a regex.
test_literal_metacharacters_only_match_themselves if {
	scope.plain_match("a.b", "a.b")
	not scope.plain_match("a.b", "axb")
	scope.plain_match("a+", "a+")
	not scope.plain_match("a+", "aaa")
	scope.plain_match("(a|b)", "(a|b)")
	not scope.plain_match("(a|b)", "a")
	scope.plain_match("^a$", "^a$")
	not scope.plain_match("^a$", "a")
	scope.path_match("a.b", "a.b")
	not scope.path_match("a.b", "axb")
	scope.path_match("[ab]", "[ab]")
	not scope.path_match("[ab]", "a")
	scope.path_match("{a,b}", "{a,b}")
	not scope.path_match("{a,b}", "a")
	scope.path_match(`a\b`, `a\b`)
}

test_patterns_match_the_whole_text if {
	not scope.plain_match("a", "ab")
	not scope.plain_match("b", "ab")
	not scope.path_match("a", "a/b")
	not scope.path_match("src/*", "xsrc/a")
}

# --- the semantics, as documented in glob.ts ---------------------------------------------------

test_path_globs if {
	scope.path_match("src/*", "src/a.ts")
	not scope.path_match("src/*", "src/a/b.ts")
	scope.path_match("src/**", "src/a/b.ts")
	not scope.path_match("src/**", "src")
	scope.path_match("src/**", "src/.env")
	scope.path_match("**/*.ts", "a/b/c.ts")
	scope.path_match("**/*.ts", "c.ts")
	scope.path_match("a/**/b", "a/b")
	scope.path_match("a/**/b", "a/x/y/b")
	not scope.path_match("a/**/b", "a/x/y/c")
}

# A `*` in the text is only a character, also where the pattern has a `*` (glob.ts used to fail
# here).
test_a_star_in_the_text_is_a_character if {
	scope.plain_match("*", "**")
	scope.path_match("*", "**")
	scope.path_match("src/*", "src/*.ts")
}

test_plain_globs_cross_separators if {
	scope.plain_match("arn:aws:s3:::bucket/*", "arn:aws:s3:::bucket/key/a")
	scope.plain_match("function/staging-*", "function/staging-eu")
	not scope.plain_match("function/staging-*", "function/prod")
}

# --- capability strings ------------------------------------------------------------------------

test_parsed if {
	scope.parsed("tasks.read") == {"base": "tasks.read", "resource": "tasks"}
	scope.parsed("workspace.write:src/**") == {"base": "workspace.write", "resource": "workspace", "scope": "src/**"}
	scope.parsed("github.create_pull_request:acme/widgets") == {"base": "github.create_pull_request", "resource": "github", "scope": "acme/widgets"}
	scope.parsed("aws.deploy:arn:aws:lambda:x").scope == "arn:aws:lambda:x"
}

test_malformed_capabilities_do_not_parse if {
	every c in ["", "tasks", "tasks.*", "Tasks.read", "tasks.read:", "tasks.read:a b", "tasks.read:a\tb", "workspace.write:/abs", "workspace.write:a/../b", "workspace.write:a//b", "workspace.write:a/", `workspace.write:a\b`, "workspace.write:./a", ".read", "tasks.:x"] {
		not scope.parsed(c)
	}
	not scope.parsed(5)
	not scope.parsed(concat("", ["tasks.read:", concat("", [x | some i in numbers.range(1, 600); x := "a"])]))
}

test_matches if {
	scope.matches("tasks.read", "tasks.read")
	scope.matches("workspace.write", "workspace.write:src/a.ts")
	not scope.matches("workspace.write:src/**", "workspace.write")
	scope.matches("workspace.write:src/**", "workspace.write:src/a.ts")
	not scope.matches("workspace.write:src/**", "workspace.write:docs/a.ts")
	not scope.matches("tasks.read", "tasks.create")
	not scope.matches("workspace.write:src/**", "workspace.write:src/../x")
	scope.matches("github.create_pull_request:acme/*", "github.create_pull_request:acme/widgets")
	not scope.matches("github.create_pull_request:acme/*", "github.create_pull_request:other/widgets")
}

test_matches_path if {
	scope.matches_path("workspace.write", "workspace.write", "")
	not scope.matches_path("workspace.write:src/**", "workspace.write", "")
	scope.matches_path("workspace.write:src/**", "workspace.write", "src/a b.ts")
	not scope.matches_path("workspace.write:src/**", "workspace.write", "src/../x")
	not scope.matches_path("workspace.write:src/**", "workspace.read", "src/a.ts")
	not scope.matches_path("tasks.read:x", "tasks.read", "x")
}

test_safe_request_path if {
	scope.safe_request_path("a/b c/d.ts")
	every p in ["", "/a", "a//b", "a/", "./a", "a/..", `a\b`, "a\u0000b", "a\nb"] {
		not scope.safe_request_path(p)
	}
}
