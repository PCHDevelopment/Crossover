# Zoekt Apache-2.0; pinned source commit dated 2026-09-11.
ARG ZOEKT_COMMIT=153817f643cde8b229ee388c1dddbcf07f4798af
FROM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS build
ARG ZOEKT_COMMIT
RUN CGO_ENABLED=0 GOBIN=/out go install \
    github.com/sourcegraph/zoekt/cmd/zoekt-webserver@${ZOEKT_COMMIT} \
    github.com/sourcegraph/zoekt/cmd/zoekt-git-index@${ZOEKT_COMMIT}

FROM alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507
RUN apk add --no-cache ca-certificates git \
    && addgroup -S -g 1000 zoekt \
    && adduser -S -D -H -u 1000 -G zoekt zoekt
COPY --from=build /out/ /usr/local/bin/
USER 1000:1000
ENTRYPOINT ["zoekt-webserver"]
CMD ["-index", "/data/index", "-listen", ":6070", "-rpc", "-html=false"]
