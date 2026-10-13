# Capability strings and their scopes (ARCHITECTURE §21.1), the Rego side of capability.ts and
# glob.ts: which grants and revocations cover an action. Everything here is a pure function of its
# arguments; authz.rego decides what a cover means.
#
# Patterns become regular expressions, matched with `regex.match`, which is RE2: matching time is
# linear in the length of the text, whatever the pattern (no backtracking), so a hostile grant or
# path cannot make a decision slow. Every pattern is anchored (`^...$`), and every regular
# expression metacharacter in the pattern's own text is escaped, so only the wildcards `*` and `?`
# (and, for paths, `**`) do anything.
package crossover.scope

import rego.v1

# Resources whose scope is a workspace path (PATH_SCOPED_RESOURCES in capability.ts).
path_scoped := {"workspace"}

max_capability_length := 512

# --- globs -----------------------------------------------------------------------------------

# The literal text of a pattern, with every regex metacharacter escaped (the backslash first).
escaped(text) := replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(text, "\\", "\\\\"), ".", "\\."), "+", "\\+"), "(", "\\("), ")", "\\)"), "|", "\\|"), "^", "\\^"), "$", "\\$"), "[", "\\["), "]", "\\]"), "{", "\\{"), "}", "\\}")

# IAM-style: `*` any run of characters (separators included), `?` exactly one.
plain_regex(pattern) := concat("", ["^", replace(replace(escaped(pattern), "*", ".*"), "?", "."), "$"])

# One path segment: `*` and `?` never cross a `/`.
segment_regex(segment) := replace(replace(escaped(segment), "*", "[^/]*"), "?", "[^/]")

# gitignore-style, over `/`-separated segments: a trailing `**` is one or more segments below the
# directory; a leading or middle `**` is zero or more directories.
path_regex(pattern) := concat("", array.concat(["^"], array.concat(pieces, ["$"]))) if {
	segments := split(pattern, "/")
	last := count(segments) - 1
	pieces := [piece |
		some i, segment in segments
		piece := path_piece(segment, i, last)
	]
}

path_piece(segment, i, last) := ".+" if {
	segment == "**"
	i == last
}

path_piece(segment, i, last) := "(.*/)?" if {
	segment == "**"
	i < last
}

path_piece(segment, i, last) := segment_regex(segment) if {
	segment != "**"
	i == last
}

path_piece(segment, i, last) := concat("", [segment_regex(segment), "/"]) if {
	segment != "**"
	i < last
}

plain_match(pattern, text) if regex.match(plain_regex(pattern), text)

path_match(pattern, path) if regex.match(path_regex(pattern), path)

# --- capability strings -----------------------------------------------------------------------

# `<resource>.<action>[:<scope>]` as {"base", "resource", "scope"?}; undefined when malformed, which
# makes every cover false (the TypeScript fails closed the same way).
parsed(capability) := p if {
	is_string(capability)
	capability != ""
	count(capability) <= max_capability_length
	colon := indexof(capability, ":")
	p := parts(capability, colon)
}

parts(capability, colon) := {"base": capability, "resource": resource_of(capability)} if {
	colon == -1
	valid_base(capability)
}

parts(capability, colon) := {"base": base, "resource": resource_of(base), "scope": scope} if {
	colon >= 0
	base := substring(capability, 0, colon)
	valid_base(base)
	scope := substring(capability, colon + 1, -1)
	valid_scope(resource_of(base), scope)
}

valid_base(base) if regex.match(`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`, base)

resource_of(base) := substring(base, 0, indexof(base, "."))

# Printable, without whitespace; for a workspace path also relative, `/`-separated, and without
# empty, `.` or `..` segments.
valid_scope(resource, scope) if {
	not resource in path_scoped
	valid_scope_text(scope)
}

valid_scope(resource, scope) if {
	resource in path_scoped
	valid_scope_text(scope)
	safe_segments(scope)
}

valid_scope_text(scope) if {
	scope != ""
	not regex.match(`[\x00-\x20\x7f]`, scope)
}

safe_segments(path) if {
	not startswith(path, "/")
	not contains(path, "\\")
	every segment in split(path, "/") {
		not segment in {"", ".", ".."}
	}
}

# A workspace path a request may name (isSafeRequestPath in capability.ts): spaces and other
# printable characters are fine in a file name, unlike in a capability scope.
safe_request_path(path) if {
	is_string(path)
	path != ""
	count(path) <= 8 * max_capability_length
	not regex.match(`[\x00-\x1f\x7f\\]`, path)
	not startswith(path, "/")
	every segment in split(path, "/") {
		not segment in {"", ".", ".."}
	}
}

# --- covers ------------------------------------------------------------------------------------

# Does the grant `g` (a parsed capability) cover the request `r` (capabilityMatches in
# capability.ts)? Same resource and action; an unscoped grant covers every scope; a scoped grant
# never covers the unscoped capability; otherwise the request's scope (literal, `*` in it is just a
# character) must match the grant's glob. The patterns are only translated once the bases agree.
covers_request(g, r) if {
	g.base == r.base
	not g.scope
}

covers_request(g, r) if {
	g.base == r.base
	g.resource in path_scoped
	path_match(g.scope, r.scope)
}

covers_request(g, r) if {
	g.base == r.base
	not g.resource in path_scoped
	plain_match(g.scope, r.scope)
}

# Does the grant `g` cover `base` applied to the workspace path `path` (capabilityMatchesPath)? ""
# is the workspace root, which only an unscoped grant covers.
covers_path(g, base, path) if {
	g.base == base
	not g.scope
	path_ok(path)
}

covers_path(g, base, path) if {
	g.base == base
	g.resource in path_scoped
	path != ""
	safe_request_path(path)
	path_match(g.scope, path)
}

path_ok(path) if path == ""

path_ok(path) if safe_request_path(path)

# The same on capability strings, for tests; the policy parses each string once and uses the above.
matches(granted, requested) if covers_request(parsed(granted), parsed(requested))

matches_path(granted, base, path) if covers_path(parsed(granted), base, path)

# Is `g` (a parsed capability) a scoped grant of `base`?
has_scope_of(g, base) if {
	g.base == base
	g.scope
}
