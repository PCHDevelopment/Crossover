FROM alpine:3.21

RUN apk add --no-cache ca-certificates git \
    && addgroup -S -g 1000 crossover \
    && adduser -S -D -H -u 1000 -G crossover crossover

COPY apps/git-fetcher/fetch-workspace /usr/local/bin/fetch-workspace
RUN chmod 0555 /usr/local/bin/fetch-workspace

USER 1000:1000
ENTRYPOINT ["/usr/local/bin/fetch-workspace"]

# T1566 THROWAWAY: a broken Dockerfile (reverted next)
RUN echo "broken on purpose" && false
